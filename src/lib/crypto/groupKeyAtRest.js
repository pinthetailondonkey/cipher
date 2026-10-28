// Group keys at rest: the 32-byte group key is sealed with AES-GCM before it
// reaches IndexedDB, under a key derived from the same session secret that
// seals message history (src/lib/messageAtRest.js). The derivation is
// HKDF-SHA256 with its own info string, so this key is separate from the
// message-history key and from every other use of the secret.
//
// This module does not touch the group cipher: the group AES-GCM key itself,
// and the AAD that binds group messages (groupCipher.js), are unchanged. It
// only wraps the stored copy of the key.
//
// Rows written before this change carry `keyHex` and no `sealed` field. They
// still read, and are resealed by the store on first use while unlocked.
// With no session secret a sealed row cannot be opened and nothing is sealed;
// the caller must not write a plaintext row in that state.
import { atRestSecretBytes } from '../messageAtRest';
import { fromHex, toHex, b64, unb64 } from './groupCipher';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

const AT_REST_VERSION = 1;
const HKDF_INFO = 'cipher group key at rest v1';

export class GroupKeyLockedError extends Error {
  constructor(message = 'The app is locked: group keys cannot be read or written until it is unlocked.') {
    super(message);
    this.name = 'GroupKeyLockedError';
  }
}

export class GroupKeyUnreadableError extends Error {
  constructor(message = 'A stored group key could not be opened.') {
    super(message);
    this.name = 'GroupKeyUnreadableError';
  }
}

let keyCache = { hex: null, key: null };

async function atRestKey() {
  const sk = atRestSecretBytes();
  if (!sk) { keyCache = { hex: null, key: null }; return null; }
  const hex = toHex(sk);
  if (keyCache.hex === hex) return keyCache.key;
  const base = await subtle.importKey('raw', sk, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(HKDF_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache = { hex, key };
  return key;
}

function aadFor(groupId, epoch, version) {
  return enc.encode(`cipher-groupkey-at-rest-${version}|${groupId}|${epoch}`);
}

export function isSealedKeyRow(row) {
  return !!row && typeof row === 'object' && !!row.sealed && typeof row.sealed.ct === 'string';
}

export function isLegacyKeyRow(row) {
  return !!row && typeof row === 'object' && !isSealedKeyRow(row) && typeof row.keyHex === 'string';
}

// True when a session secret is present, i.e. rows can be sealed and opened.
export function groupKeysUnlocked() {
  return !!atRestSecretBytes();
}

// Returns a copy of the row with `keyHex` replaced by `sealed`. Throws
// GroupKeyLockedError when there is no session secret — never a plaintext row.
export async function sealGroupKeyRow(row) {
  if (isSealedKeyRow(row)) return row;
  const key = await atRestKey();
  if (!key) throw new GroupKeyLockedError();
  const { keyHex, ...rest } = row;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(row.groupId, row.epoch, AT_REST_VERSION) },
    key,
    fromHex(keyHex),
  );
  return { ...rest, sealed: { v: AT_REST_VERSION, iv: b64(iv), ct: b64(new Uint8Array(ct)) } };
}

// Returns the key bytes of a stored row. Legacy plaintext rows read as stored.
// A sealed row with no session secret throws GroupKeyLockedError; one that
// fails the AES-GCM check (tampered, moved to another group or epoch, or the
// wrong secret) throws GroupKeyUnreadableError. Neither returns key bytes.
export async function openGroupKeyRow(row) {
  if (!isSealedKeyRow(row)) {
    if (row && typeof row.keyHex === 'string') return fromHex(row.keyHex);
    throw new GroupKeyUnreadableError('A stored group key row has no key.');
  }
  const key = await atRestKey();
  if (!key) throw new GroupKeyLockedError();
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(row.sealed.iv), additionalData: aadFor(row.groupId, row.epoch, row.sealed.v) },
      key,
      unb64(row.sealed.ct),
    );
    return new Uint8Array(pt);
  } catch {
    throw new GroupKeyUnreadableError();
  }
}
