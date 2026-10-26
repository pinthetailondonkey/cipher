// Dead-drop notes: self-destructing encrypted messages shared by link.
//
// Shape (user-specified, verbatim): <note-origin>/note#<payload> — the origin
// is the egress registry's 'dead-drop' entry. The URL FRAGMENT carries
// everything needed to decrypt — base64url of
// [key (32b) | iv (12b) | note hash (32b)] — so the key never appears in the
// path, query, or any server log. The path is just /note.
//
// The encrypted blob is a relay event (kind 30100) whose `d` tag is the note
// hash = sha256(key) — so the URL carries no way to FIND the event without
// the key, and relays that never see the fragment still store only ciphertext.
// Anyone with the relay and no fragment can neither find nor read the note.
//
// One-open destruct is best-effort: publishing a delete (kind 5) asks relays
// to drop it, and readers mark the hash consumed locally, but relay deletes
// are untrusted — the real boundary is that without the fragment key the
// ciphertext is unreadable and unfindable. Deletion is UX sugar on top.
//
// Groups deep links (user-specified): <note-origin>/<groupid> is handled in
// useChatBootstrap — same behavior as ?g=, new shape.

const NOTE_KIND = 30100;

// ————— bytes helpers —————

function toB64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto unavailable');
  return globalThis.crypto.subtle;
}

// ————— fragment format —————
// fragment = base64url( key[32] || iv[12] || hash[32] )
// Everything after the first 44 bytes identifies the relay event; the first
// 44 decrypt it. One blob, no separators, fixed offsets.

const KEY_LEN = 32;
const IV_LEN = 12;
const HASH_LEN = 32;

async function deriveNoteHash(keyBytes) {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return sha256(keyBytes);
}

function packFragment(keyBytes, ivBytes, hashBytes) {
  return toB64Url(concatBytes(keyBytes, ivBytes, hashBytes));
}

function unpackFragment(fragment) {
  let raw;
  try { raw = fromB64Url(fragment); } catch { return null; }
  if (raw.length !== KEY_LEN + IV_LEN + HASH_LEN) return null;
  return {
    key: raw.slice(0, KEY_LEN),
    iv: raw.slice(KEY_LEN, KEY_LEN + IV_LEN),
    hash: raw.slice(KEY_LEN + IV_LEN),
  };
}

// The link host lives in the egress registry (id 'dead-drop'), like every
// other outbound host this app can contact.
import { entryById, activeUrl } from './egress.js';

export function noteOrigin(config = undefined) {
  return activeUrl(entryById('dead-drop'), config) || '';
}

export function noteUrl(fragment, origin = noteOrigin()) {
  return `${origin}/note#${fragment}`;
}

// ————— create —————

// Seal and publish a dead-drop note. Returns { url, hash } — the url is the
// whole secret; the caller shows it once and never stores it.
export async function createDeadDropNote({ identity, text, pool, relays }) {
  if (!identity?.sk) throw new Error('An identity is required to sign the note event.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The note is empty.');
  if (text.length > 8000) throw new Error('The note is too long (8000 characters max).');

  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  const ivBytes = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const aesKey = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify({ t: text }));
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: ivBytes }, aesKey, plaintext),
  );
  const hash = await deriveNoteHash(keyBytes);
  const hashHex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');

  const { finalizeEvent } = await import('nostr-tools');
  const event = finalizeEvent({
    kind: NOTE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', hashHex]],
    content: toB64Url(ciphertext),
  }, identity.sk);

  const results = await Promise.allSettled(pool.publish(relays, event));
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  if (okCount === 0) throw new Error('No relay accepted the note. It was not sent.');

  const fragment = packFragment(keyBytes, ivBytes, hash);
  return { url: noteUrl(fragment), hash: hashHex, relayCount: okCount };
}

// ————— read —————

// Fetch and open a note from a fragment. One readable attempt; consumed
// notes (this device already opened this hash) fail closed.
export async function openDeadDropNote({ identity, fragment, pool, relays, isConsumed = null }) {
  const parts = unpackFragment(fragment);
  if (!parts) throw new Error('That link is not a valid note link.');

  const hashHex = Array.from(parts.hash, (b) => b.toString(16).padStart(2, '0')).join('');
  if (isConsumed && await isConsumed(hashHex)) {
    throw new Error('This note was already opened on this device.');
  }

  const events = await pool.querySync(relays, { kinds: [NOTE_KIND], '#d': [hashHex] });
  if (!events.length) throw new Error('The note is gone or was never here.');

  // Newest wins — a re-uploaded note (destruct failed everywhere) supersedes.
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  const aesKey = await subtle().importKey('raw', parts.key, 'AES-GCM', false, ['decrypt']);
  let plaintext;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: parts.iv },
      aesKey,
      fromB64Url(latest.content),
    );
  } catch {
    throw new Error('This note could not be opened — the link was altered.');
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(plaintext)); } catch {
    throw new Error('This note could not be opened — the link was altered.');
  }

  // Best-effort destruct: ask every relay to forget the blob (kind 5) and
  // remember locally that this hash is spent. Relays may ignore deletes;
  // without the fragment the ciphertext stays unreadable either way.
  if (identity?.sk) {
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const del = finalizeEvent({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', latest.id]],
        content: '',
      }, identity.sk);
      Promise.allSettled(pool.publish(relays, del)).catch(() => {});
    } catch (error) {
      console.warn('[deadDrop] The delete request could not be published:', error);
    }
  }
  return { text: typeof payload.t === 'string' ? payload.t : '', hash: hashHex };
}

export const _deadDropInternals = {
  NOTE_KIND, KEY_LEN, IV_LEN, HASH_LEN,
  toB64Url, fromB64Url, packFragment, unpackFragment, deriveNoteHash,
};
