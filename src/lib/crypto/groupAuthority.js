// The per-group authority key (Step 0 decision, MEMBERSHIP-DESIGN.md).
//
// HKDF(account secret, gid salt) -> a secp256k1 keypair. The pin (compressed
// pubkey) travels in the invite link; the private half never leaves the owner's
// device and is recomputed from the account key on demand, so nothing new is
// stored. One derivation backs both artifacts that need it: this doc signer
// (Step 1) and the group GM signing key for AUTH / kind-9 (Step 2).
//
// Derivation pattern follows orderEscrowKey (escrowActions.js): WebCrypto
// HKDF-SHA-256 over the 32-byte account secret with a fixed info string and
// the gid bytes as salt.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const GROUP_AUTHORITY_HKDF_INFO = 'cipher-group-authority-key-v1';

const HEX66 = /^[0-9a-f]{66}$/;

// A gid in the wild can be any non-empty string (a relay-assigned id), but a
// hostile one is unbounded in length. Bound it: a gid longer than this is not
// an id this app created.
const GID_MAX_CHARS = 128;

function gidSaltBytes(gid) {
  const text = String(gid || '').trim();
  if (!text || text.length > GID_MAX_CHARS) throw new Error('Bad group id.');
  return new TextEncoder().encode(`cipher-gid:${text}`);
}

async function hkdfBits(secretBytes, saltBytes, info, bits) {
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info },
    base,
    bits,
  );
}

// Async, so only handlers call it — same discipline as the escrow derivation.
// Returns { privateKeyBytes, pin } where pin is the compressed-pubkey hex the
// invite link carries. Nothing is written anywhere.
export async function groupAuthorityKey(secretKeyBytes, gid) {
  if (!(secretKeyBytes instanceof Uint8Array) || secretKeyBytes.length !== 32) {
    throw new Error('Derive the group authority key from the account 32-byte secret.');
  }
  const bits = await hkdfBits(
    secretKeyBytes,
    gidSaltBytes(gid),
    new TextEncoder().encode(GROUP_AUTHORITY_HKDF_INFO),
    256,
  );
  const privateKeyBytes = new Uint8Array(bits);
  const pin = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
  return { privateKeyBytes, pin };
}

export function validPin(pin) {
  return HEX66.test(String(pin || '').toLowerCase().trim());
}

export function looksLikeGid(value) {
  const text = String(value || '').trim();
  return Boolean(text) && text.length <= GID_MAX_CHARS;
}

// Invite-link helpers. The pin rides as `a` (authority), separate from `g` so
// links without a pin keep parsing exactly as before. A missing or malformed
// pin must degrade to "no pin", never to a fetched value: the pin's whole job
// is to be learned out of band (H5), so there is no fallback source for it.
export function inviteLinkWithPin(originPathname, gid, pin) {
  if (!looksLikeGid(gid) || !validPin(pin)) return '';
  const base = `${originPathname}${originPathname.includes('?') ? '&' : '?'}g=${encodeURIComponent(gid)}`;
  return `${base}&a=${encodeURIComponent(String(pin).toLowerCase())}`;
}

export function authorityPinFromLink(searchParams) {
  try {
    const raw = typeof searchParams?.get === 'function'
      ? searchParams.get('a')
      : searchParams?.a;
    const text = String(raw || '');
    return validPin(text) ? text.toLowerCase() : '';
  } catch {
    return '';
  }
}
