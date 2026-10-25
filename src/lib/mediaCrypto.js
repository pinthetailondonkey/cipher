import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

// Chat photos and voice notes are encrypted on this device before they leave
// it. The media host stores ciphertext under a throwaway upload key, so it
// cannot read the file or tie it to the sender. The AES key travels inside
// the already-encrypted message, so only the people who can read the message
// can open the file. The host still sees the sender's IP at upload, and each
// reader's IP and the time they opened it.

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

export function isPrivateMedia(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.url && entry.key && entry.iv);
}

const opened = new Map();

// Fetches the ciphertext once per attachment and hands back a blob: URL.
export function openPrivateMedia(entry, fetchImpl = globalThis.fetch) {
  const cacheKey = `${entry.url}#${entry.key}`;
  if (!opened.has(cacheKey)) {
    const pending = (async () => {
      const response = await fetchImpl(entry.url);
      if (!response.ok) throw new Error(`The media host answered ${response.status}.`);
      const blob = await decryptMedia(new Uint8Array(await response.arrayBuffer()), entry);
      return URL.createObjectURL(blob);
    })();
    opened.set(cacheKey, pending);
    pending.catch(() => opened.delete(cacheKey));
  }
  return opened.get(cacheKey);
}
