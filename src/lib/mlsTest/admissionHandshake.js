// Admission handshake validation for the MLS v1 test profile
// (docs/MLS-TEST-PROFILE-V1.md Section 1 "Admission handshake shape").
//
// TEST PROFILE ONLY. Pure validation: an applicant signs
// (groupId, leafKeyHash, nonce) with its account key; the owner verifies
// the account-to-actor binding locally and only then issues a Welcome.
// No relay, no real KeyPackage here.

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalHash } from './governanceBinding.js';

// Build the applicant's admission request.
export async function buildAdmissionRequest({ groupId, leafKeyHash, nonce, accountSecretKey }) {
  if (!/^[0-9a-f]{64}$/.test(String(leafKeyHash || ''))) return null;
  if (typeof nonce !== 'string' || nonce.length < 16) return null;
  const binding = {
    groupId: String(groupId || ''),
    leafKeyHash: String(leafKeyHash).toLowerCase(),
    nonce,
    t: 'mlsadmreq',
  };
  const messageHash = await canonicalHash(binding);
  const message = new Uint8Array(messageHash.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const signature = ed25519.sign(message, accountSecretKey);
  return {
    binding,
    bindingHash: messageHash,
    pubkey: bytesToHex(ed25519.getPublicKey(accountSecretKey)),
    sig: bytesToHex(signature),
  };
}

function hexToBytes(hex) {
  return new Uint8Array(String(hex).match(/.{2}/g).map((h) => parseInt(h, 16)));
}

// Owner-side validation of an admission request.
export async function verifyAdmissionRequest(request, { maxAgeSeconds = 86400, now = Date.now() } = {}) {
  try {
    if (!request || typeof request !== 'object') return null;
    if (typeof request.receivedAt === 'number'
      && now - request.receivedAt > maxAgeSeconds * 1000) return null; // D3 window
    const rebuilt = await canonicalHash(request.binding);
    if (rebuilt !== request.bindingHash) return null;
    const ok = ed25519.verify(
      hexToBytes(request.sig),
      hexToBytes(request.bindingHash),
      hexToBytes(request.pubkey),
    );
    return ok ? { ...request.binding, pubkey: request.pubkey } : null;
  } catch {
    return null;
  }
}

// Account-to-actor binding: the owner keeps this mapping locally after
// verifying the account key signature against the known account pubkey.
export function bindActorToAccount({ admission, actorPublicKey, knownAccountPubkey }) {
  if (!admission || admission.pubkey !== String(knownAccountPubkey || '').toLowerCase()) return null;
  if (!/^[0-9a-f]{64}$/.test(String(actorPublicKey || ''))) return null;
  return { actorPublicKey: actorPublicKey.toLowerCase(), accountPubkey: admission.pubkey };
}
