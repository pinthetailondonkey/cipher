// Contact-visible identity verification for independent device-authority
// recovery roots. A new key is accepted only after a person compares this full
// fingerprint through a separately authenticated channel.
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyDeviceAuthorityPolicy, verifyDeviceAuthorityRegistry } from './deviceAuthority.js';

const HEX64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export function recoveryIdentityFingerprint(accountPubkey, recoveryPubkey) {
  if (!HEX64.test(accountPubkey || '') || !HEX64.test(recoveryPubkey || '')) {
    throw new Error('A valid account and recovery identity are required for contact verification.');
  }
  const bytes = sha256(encoder.encode(`cipher-recovery-contact-fingerprint-v1|${accountPubkey}|${recoveryPubkey}`));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{1,4}/g).join(' ');
}

function normalizeFingerprint(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : '';
}

// This verifies the *result* of an independent comparison; it cannot prove
// that the human used an independent channel. Production UI must show the same
// full fingerprint on both accounts and require explicit user confirmation.
export function verifyRecoveryRootReplacement({ currentPolicyEvent, nextPolicyEvent,
  nextRegistryEvent, expectedAccountPubkey, expectedOldRecoveryPubkey,
  confirmedFingerprint, now = Math.floor(Date.now() / 1000) } = {}) {
  const current = verifyDeviceAuthorityPolicy(currentPolicyEvent, {
    expectedAccount: expectedAccountPubkey,
    expectedRecovery: expectedOldRecoveryPubkey,
    now,
  });
  if (!current) return null;
  let nextBody;
  try { nextBody = JSON.parse(nextPolicyEvent?.content || ''); } catch { return null; }
  const next = verifyDeviceAuthorityPolicy(nextPolicyEvent, {
    expectedAccount: expectedAccountPubkey,
    expectedRecovery: nextBody?.recoveryPubkey,
    now,
  });
  if (!next || nextPolicyEvent.pubkey !== next.recoveryPubkey
    || next.recoveryPubkey === current.recoveryPubkey
    || next.authorityEpoch !== current.authorityEpoch + 1
    || next.previousPolicyId !== currentPolicyEvent.id
    || nextPolicyEvent.created_at < currentPolicyEvent.created_at
    || normalizeFingerprint(confirmedFingerprint)
      !== normalizeFingerprint(recoveryIdentityFingerprint(expectedAccountPubkey, next.recoveryPubkey))) return null;
  const registry = verifyDeviceAuthorityRegistry(nextRegistryEvent, nextPolicyEvent, { now });
  if (!registry || registry.generation !== 1) return null;
  return { accountPubkey: next.accountPubkey, oldRecoveryPubkey: current.recoveryPubkey,
    recoveryPubkey: next.recoveryPubkey, policyId: nextPolicyEvent.id,
    authorityEpoch: next.authorityEpoch, registryId: nextRegistryEvent.id };
}
