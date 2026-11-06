// SEC-1 remediation: the governance-doc content key.
//
// Before this file, a kind-30079 member-set document was sealed under
// SHA-256(`cipher-gmemdoc-key-v1:<pin>:<gid>`). Every input was printed on
// the wire event itself: the pin is derivable from the author pubkey (02||x
// or 03||x compressed form) and the gid is the d-tag, so any relay observer
// decrypted the private roster of a sealed group with public fields alone
// (witnessed by the inline observer test in groupDocWire.test.js).
//
// Now the content key is a random 32-byte per-group secret created at
// genesis, held like chat keys are held, and shared only through the sealed
// NIP-44/NIP-59 gkey bundle riders members already trust. HKDF-SHA-256 over
// that secret produces the AES-GCM input, with an info string distinct from
// every other derivation in the codebase so no two paths share derived bits.
// Rotation happens wherever chat epochs rotate (a kick's rotateGroupEpoch),
// and the freshly rotated secret rides the same bundles that deliver the new
// epoch. Devices without the secret refuse to decrypt the doc rather than
// falling back to a publicly derivable key (H4's null-path discipline).

import { toHex, fromHex } from './groupCipher';

export const DOC_KEY_HKDF_INFO = 'cipher-gmemdoc-aes-v2';
const KEY_HEX_RE = /^[0-9a-f]{64}$/;

export function generateDocKey() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// Accepts what callers hold across stores and payloads: raw bytes, hex, or a
// JSON-encoded string field that may arrive padded. Returns 32 clean bytes or
// null; never throws on user-shaped junk.
export function normalizeDocKey(value) {
  if (!(value instanceof Uint8Array)) {
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      value = parsed;
    } catch {
      // fall through as a plain string
    }
    if (typeof value !== 'string') {
      // A decoded object may itself be a plain string already handled above.
      return null;
    }
    const text = String(value).toLowerCase().replace(/[^0-9a-f]/g, '');
    if (!KEY_HEX_RE.test(text)) return null;
    try { value = fromHex(text); } catch { return null; }
  }
  if (!(value instanceof Uint8Array) || value.length !== 32) return null;
  const out = new Uint8Array(32);
  out.set(value.subarray(0, 32));
  return out;
}

export function docKeyToHex(bytes) {
  const norm = normalizeDocKey(bytes);
  return norm ? toHex(norm) : '';
}

export function docKeysEqual(a, b) {
  const left = normalizeDocKey(a);
  const right = normalizeDocKey(b);
  if (!left || !right) return false;
  for (let i = 0; i < 32; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

// HKDF-SHA-256, zero salt, fixed info — mirrors the pattern groupAuthority.js
// uses so audit reads one shape everywhere. Async, so only handlers call it.
export async function deriveDocAesInput(docKeyBytes) {
  const normalized = normalizeDocKey(docKeyBytes);
  if (!normalized) return null;
  const base = await crypto.subtle.importKey('raw', normalized, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(DOC_KEY_HKDF_INFO) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function docKeyFromSerialized(value) {
  return deriveDocAesInput(normalizeDocKey(value));
}
