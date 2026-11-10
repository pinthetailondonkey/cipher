// Epoch attestation sign/verify for the MLS v1 test profile
// (docs/MLS-TEST-PROFILE-V1.md Section 3, plan item 15).
//
// TEST PROFILE ONLY. Each member signs one attestation per epoch binding
// (groupId, epoch, transcriptHash, commitHash) with its group-actor device
// key. Ed25519 from the existing @noble/curves dependency. Admins compare
// attestations collected across at least two relays; a mismatch freezes
// the group (equivocation).

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalHash } from './governanceBinding.js';

export const ATTEST_T = 'mlsePOCHATT';
export const ATTEST_V = 1;

export function generateAttestationKey() {
  return ed25519.keygen();
}

export function attestPublicKey(secretKeyBytes) {
  return ed25519.getPublicKey(secretKeyBytes);
}

// Sign one attestation. Returns the signed event (hex fields) or null on
// bad input. `commitHash` is the hash of the commit that produced the epoch.
export async function signEpochAttestation({
  groupId, epoch, transcriptHash, commitHash, secretKey,
}) {
  try {
    if (!/^[0-9a-f]{64}$/.test(String(transcriptHash || ''))) return null;
    if (!/^[0-9a-f]{64}$/.test(String(commitHash || ''))) return null;
    const epochNum = Number(epoch);
    if (!Number.isInteger(epochNum) || epochNum < 0) return null;
    const binding = {
      commitHash: String(commitHash).toLowerCase(),
      epoch: epochNum,
      groupId: String(groupId || ''),
      t: ATTEST_T.toLowerCase(),
      transcriptHash: String(transcriptHash).toLowerCase(),
      v: ATTEST_V,
    };
    const messageHash = await canonicalHash(binding);
    const signature = ed25519.sign(
      new Uint8Array(messageHash.match(/.{2}/g).map((h) => parseInt(h, 16))),
      secretKey,
    );
    return {
      binding,
      bindingHash: messageHash,
      pubkey: bytesToHex(ed25519.getPublicKey(secretKey)),
      sig: bytesToHex(signature),
    };
  } catch {
    return null;
  }
}

function hexToBytes(hex) {
  return new Uint8Array(String(hex).match(/.{2}/g).map((h) => parseInt(h, 16)));
}

// Verify one attestation against its claimed pubkey.
export async function verifyEpochAttestation(attestation) {
  try {
    if (!attestation || typeof attestation !== 'object') return null;
    const rebuilt = await canonicalHash(attestation.binding);
    if (rebuilt !== attestation.bindingHash) return null;
    const ok = ed25519.verify(
      hexToBytes(attestation.sig),
      hexToBytes(attestation.bindingHash),
      hexToBytes(attestation.pubkey),
    );
    return ok ? { ...attestation.binding, pubkey: attestation.pubkey } : null;
  } catch {
    return null;
  }
}

// Compare the per-relay attestation sets an admin collected. Each set is
// an array of verified attestations for one relay. Any disagreement about
// (groupId, epoch) transcriptHash across relays is equivocation.
export function detectEquivocation({ groupId, epoch, relaySets }) {
  const sets = Array.isArray(relaySets) ? relaySets : [];
  if (sets.length < 2) return { equivocation: false, reason: 'insufficient-relays' };
  const byHash = new Map();
  for (let i = 0; i < sets.length; i += 1) {
    for (const att of sets[i]) {
      if (!att || typeof att !== 'object') continue;
      if (att.groupId !== groupId || att.epoch !== epoch) continue;
      const key = att.transcriptHash;
      if (!byHash.has(key)) byHash.set(key, new Set());
      byHash.get(key).add(att.pubkey);
    }
  }
  if (byHash.size > 1) return { equivocation: true, hashes: [...byHash.keys()] };
  if (byHash.size === 0) return { equivocation: false, reason: 'no-attestations' };
  return { equivocation: false, transcriptHash: [...byHash.keys()][0] };
}
