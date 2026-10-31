import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { compressImage } from './imageCompression.js';

// Chat photos and voice notes are encrypted on this device before they leave
// it. The media host stores ciphertext under a throwaway upload key, so it
// cannot read the file or tie it to the sender. The host still sees the
// sender's IP at upload, and each reader's IP and the time they opened it.
//
// Where the key lives: every attachment gets its own random AES-256-GCM key
// and IV. They sit in the message body, next to the URL, as
// { url, key, iv, mime }, and that body is itself NIP-44 or group-epoch
// encrypted. Nothing else holds the key. The URL alone opens nothing.

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function encryptMedia(file) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plain = new Uint8Array(await file.arrayBuffer());
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    ciphertext,
    meta: { key: toBase64(keyBytes), iv: toBase64(iv), mime: file.type || 'application/octet-stream' },
  };
}

export async function decryptMedia(ciphertext, meta) {
  const key = await crypto.subtle.importKey('raw', fromBase64(meta.key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(meta.iv) }, key, ciphertext);
  return new Blob([plain], { type: meta.mime || 'application/octet-stream' });
}

function base64Url(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A Blossom PUT over plain fetch, so a pasted http onion host works as well
// as an https one. Each server gets its own throwaway key and an auth event
// bound to that host. Redirects are refused, so the bytes and the auth go
// only where the user pointed them.
export async function uploadCiphertext(bytes, { servers = [], fetchImpl = globalThis.fetch } = {}) {
  const hash = bytesToHex(sha256(bytes));
  const reasons = [];
  for (const base of servers) {
    let server;
    try {
      server = new URL(base);
      if (server.protocol !== 'https:' && server.protocol !== 'http:') throw new Error('not http or https');
    } catch (error) {
      reasons.push(`${base}: ${error.message}`);
      continue;
    }
    const key = generateSecretKey();
    try {
      const now = Math.floor(Date.now() / 1000);
      const auth = finalizeEvent({
        kind: 24242,
        created_at: now,
        tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + 300)], ['server', server.hostname.toLowerCase()]],
        content: 'Upload blob',
      }, key);
      const response = await fetchImpl(`${server.href.replace(/\/$/, '')}/upload`, {
        method: 'PUT',
        redirect: 'error',
        // not UI copy: the Blossom upload auth header scheme is wire format.
        headers: { Authorization: `Nostr ${base64Url(JSON.stringify(auth))}`, 'Content-Type': 'application/octet-stream', 'X-SHA-256': hash },
        body: bytes,
      });
      if (!response.ok) {
        reasons.push(`${base}: ${response.status}`);
        continue;
      }
      const descriptor = await response.json();
      const url = new URL(String(descriptor?.url || ''));
      if (descriptor.sha256 !== hash || descriptor.size !== bytes.length || !['https:', 'http:'].includes(url.protocol)) {
        reasons.push(`${base}: the host answered for a different file`);
        continue;
      }
      return { url: url.href };
    } catch (error) {
      reasons.push(`${base}: ${error?.message || error}`);
    } finally {
      key.fill(0);
    }
  }
  throw new Error(`No media host took the encrypted file. ${reasons.join('; ')}`);
}

// There is no plaintext fallback. A host that refuses the encrypted file
// means the attachment is not sent.
export async function uploadPrivateMedia(file, servers, upload = uploadCiphertext) {
  const { ciphertext, meta } = await encryptMedia(file);
  const blob = await upload(ciphertext, { servers });
  return { url: blob.url, ...meta };
}

// A photo is re-encoded first, which drops EXIF and location, and encrypted
// after. In the other order the canvas would get ciphertext and the
// metadata would ride inside the encrypted file to every reader.
export async function sendPrivateImage(file, servers, { compress = compressImage, upload = uploadCiphertext } = {}) {
  const clean = await compress(file);
  return uploadPrivateMedia(clean, servers, upload);
}

// One door for an attachment, so a caller cannot pick the wrong one. A photo
// is re-encoded first, which drops EXIF and location (VISION.md invariant 5),
// and encrypted after; anything else — a PDF — keeps its bytes, because a
// canvas round-trip would destroy the file. There is no raw fallback: if the
// re-encode throws, nothing is uploaded.
export async function uploadAttachment(file, servers, { compress = compressImage, upload = uploadCiphertext } = {}) {
  const bytes = file.type?.startsWith('image/') ? await compress(file) : file;
  return uploadPrivateMedia(bytes, servers, upload);
}

// The toast for a failed photo upload. Only the upload's own refusal
// sentence carries host reasons; an earlier throw (reading or encrypting
// the file) is a raw browser string and never reaches the screen. The host
// list is capped at three so the toast stays a line, not a wall.
export function photoRefusalToast(raw) {
  const sentence = 'No media host took the encrypted file.';
  const refused = `The photo was not sent. ${sentence}`;
  const text = String(raw || '');
  if (!text.startsWith(sentence)) return refused;
  const reasons = text.slice(sentence.length).trim().split('; ').filter(Boolean);
  if (!reasons.length) return refused;
  const shown = reasons.slice(0, 3);
  const rest = reasons.length - shown.length;
  const tail = rest > 0 ? `; and ${rest} more host${rest === 1 ? '' : 's'}` : '';
  return `${refused} ${shown.join('; ')}${tail}`;
}

export function isPrivateMedia(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.url && entry.key && entry.iv);
}

// What a bubble should draw. Messages from before encryption carry a plain
// URL and still render as they did. A private entry is fetched and decrypted.
export function attachmentsFor(content) {
  const item = (entry) => ({ shape: isPrivateMedia(entry) ? 'private' : 'plain', entry });
  if (content?.type === 'image' && content.url) return { layout: 'single', items: [item(content)] };
  if (content?.type === 'audio' && content.url) return { layout: 'audio', items: [item(content)] };
  if (content?.type === 'album') {
    // Album entries are private-shaped or nothing (1.121 candidate, on the
    // founder card). The old legacy path accepted a plain `urls` list, which
    // let any group member name the hosts every viewer's browser fetches —
    // a beacon of who is in the group and when they looked. The old
    // `urls` shape died with pre-encryption sends; nothing legitimate lost.
    const entries = Array.isArray(content.media) ? content.media.filter(isPrivateMedia) : [];
    if (entries.length) return { layout: 'grid', items: entries.map(item) };
  }
  return { layout: null, items: [] };
}

const opened = new Map();

function cacheKeyOf(entry) {
  return `${entry.url}#${entry.key}`;
}

// Fetches the ciphertext once per attachment and hands back a blob: URL.
// Each open is matched by a release; the last release revokes the URL.
export function openPrivateMedia(entry, fetchImpl = globalThis.fetch) {
  const cacheKey = cacheKeyOf(entry);
  let record = opened.get(cacheKey);
  if (!record) {
    const pending = (async () => {
      const response = await fetchImpl(entry.url);
      if (!response.ok) throw new Error(`The media host answered ${response.status}.`);
      const blob = await decryptMedia(new Uint8Array(await response.arrayBuffer()), entry);
      return URL.createObjectURL(blob);
    })();
    record = { pending, refs: 0 };
    opened.set(cacheKey, record);
    pending.catch(() => opened.delete(cacheKey));
  }
  record.refs += 1;
  return record.pending;
}

export function releasePrivateMedia(entry) {
  const cacheKey = cacheKeyOf(entry);
  const record = opened.get(cacheKey);
  if (!record) return;
  record.refs -= 1;
  if (record.refs > 0) return;
  opened.delete(cacheKey);
  record.pending.then((src) => URL.revokeObjectURL(src), () => {});
}
