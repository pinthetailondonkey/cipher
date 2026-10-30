// The second key from one scan.
//
// A single credentials.get() can carry two PRF eval inputs on the same
// credential (extensions.prf.eval.{first,second}) and returns two independent
// 32-byte outputs. The first is the key the device layer already uses — it
// must equal nostr-passkey's own derivation byte for byte, or every vault
// sealed today stops opening. The second is new: it wraps the account key so
// one scan alone can open the account without the PIN.
//
// The second input never reuses the library's context string. Two inputs
// hashed the same way would be one key asked for twice, and the whole point is
// that holding one of them does not open what the other one wraps.
//
// Nothing here talks to the browser: it is the derivation, the seal and the
// open, so the boundary cases can be measured in node.

import { DeviceKeyMissing } from './vaultEnvelope.js';

// Mirror of the library's v2 constants (dist, PRF_CONTEXT_V2 and
// AES_INFO_STRING). Pinned by a test against the library itself, so a rename
// on either side fails the suite instead of stranding stored vaults.
// not UI copy: the library's own hashing context.
export const LIB_PRF_CONTEXT_V2 = 'nostr-passkey-nsec-v2';
// not UI copy: the library's own HKDF info string.
export const LIB_AES_INFO = 'nostr-passkey-aes-key';

// Ours, and deliberately different from the library's string.
export const WALLET_CONTEXT = 'cipher-wallet-a2';

// What marks a vault as carrying the second key. It rides a sibling field and
// leaves v and dk.k exactly as they are: a version bump would send an old
// build down the legacy no-salt path, which charges a PIN attempt.
export const WALLET_SCHEME = 'a2';

const enc = new TextEncoder();

const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A salt is bytes, and a stored salt is base64url text. Letting the text be
// read as bytes silently produced a different PRF input and therefore a
// different key — the failure only showed up against a real authenticator, so
// this refuses instead of guessing.
const asBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('expected salt bytes; decode the stored base64url first (base64UrlToBytes)');
};

// A PRF output is normally 32 bytes; anything else is hashed to 32 the way the
// library does, so both sides of the comparison always see the same length.
export async function normalizePrfOutput(result) {
  const bytes = asBytes(result);
  return bytes.byteLength === 32 ? bytes : sha256(bytes);
}

// The input the device layer has always asked for. Same salt, same context.
export async function devicePrfInput(recordSalt) {
  return sha256(concat(asBytes(recordSalt), enc.encode(LIB_PRF_CONTEXT_V2)));
}

// The input for the second key.
export async function walletPrfInput(salt) {
  return sha256(concat(asBytes(salt), enc.encode(WALLET_CONTEXT)));
}

// Same HKDF the library uses for the device layer. Kept here so the lab can
// prove the hand derivation equals the library's on a real credential.
export async function deriveLibraryKey(prfOutput, salt) {
  const material = await crypto.subtle.importKey('raw', asBytes(prfOutput), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBytes(salt), info: enc.encode(LIB_AES_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveWalletKey(prfOutput, salt) {
  const material = await crypto.subtle.importKey('raw', asBytes(prfOutput), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBytes(salt), info: enc.encode(WALLET_CONTEXT) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const walletAad = (pk) => enc.encode(`${WALLET_CONTEXT}|${pk}`);

// Seals the account key under the second PRF output. The account id rides the
// additional data, so a blob copied onto another account's vault does not open.
export async function sealAccountKey(accountSecret, walletKey, pk) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: walletAad(pk) },
    walletKey,
    asBytes(accountSecret),
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(data)) };
}

// A blob that does not open is a DEVICE error, never a wrong PIN: the person
// is holding the right phone and may be typing the right PIN. DeviceKeyMissing
// is what keeps the five-wrong-PINs counter out of it.
export async function openAccountKey(blob, walletKey, pk) {
  // Strict on purpose: a 12-byte iv and a non-empty body are the whole format,
  // so a half-written record is refused here rather than somewhere that has to
  // guess whether it was the key or the record that was wrong.
  if (!blob || !Array.isArray(blob.iv) || blob.iv.length !== 12 || !Array.isArray(blob.data) || blob.data.length === 0) {
    throw new DeviceKeyMissing('wallet-malformed');
  }
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(blob.iv), additionalData: walletAad(pk) },
      walletKey,
      new Uint8Array(blob.data),
    );
  } catch {
    throw new DeviceKeyMissing('wallet-wrong-key');
  }
  return new Uint8Array(plain);
}

// True only when the vault really carries everything the one-scan path needs.
export const hasSecondKey = (vault) => !!vault
  && typeof vault === 'object'
  && vault.dk?.scheme === WALLET_SCHEME
  && typeof vault.dk?.salt2 === 'string'
  && !!vault.wallet;

// Adds the second key to a vault WITHOUT touching v, dk.k or the existing
// device layer. An old build meeting this vault reads dk.k === 'prf', derives
// with the single input, fails to open the device layer and refuses with
// DeviceKeyMissing — measured, and pinned by a test.
export function withSecondKey(vault, { salt2, wallet }) {
  if (!vault || typeof vault !== 'object') throw new DeviceKeyMissing('malformed');
  if (!vault.dk || typeof vault.dk.k !== 'string') throw new DeviceKeyMissing('malformed');
  return { ...vault, dk: { ...vault.dk, scheme: WALLET_SCHEME, salt2 }, wallet };
}
