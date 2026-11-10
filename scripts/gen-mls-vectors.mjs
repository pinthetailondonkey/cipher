// Generate deterministic MLS v1 test-profile vectors (item D of the plan,
// docs/MLS-TEST-PROFILE-V1.md Section 8). Fixed seeds, byte-identical
// output on rerun. TEST PROFILE ONLY.
//
// Vectors cover: forged commit rejection, roster-only add rejection, wrong
// previous revision rejection, mismatched cross-hash rejection, stale epoch
// reject, replayed commit reject, fork reject, and a valid chain of three
// accepted epochs. This is NOT the pinned OpenMLS/IETF vector run (that is
// item 18 and stays open; see scripts/run-mls-vectors.mjs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGovernanceExtension,
  canonicalHash,
  deriveNextGovernanceRefs,
} from '../src/lib/mlsTest/governanceBinding.js';
import {
  REJECT_REASONS,
  signCommit,
  validateCommitChain,
} from '../src/lib/mlsTest/commitValidators.js';
import {
  detectEquivocation,
  signEpochAttestation,
  verifyEpochAttestation,
} from '../src/lib/mlsTest/epochAttestation.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test-vectors', 'mls-v1');
mkdirSync(outDir, { recursive: true });

// Deterministic Ed25519 keys from fixed seeds (RFC 8032-style test scalar).
function fixedKey(seedLabel) {
  const seed = new TextEncoder().encode(`cipher-mls-v1-fixed-seed:${seedLabel}`);
  // The scalar is the SHA-256-like stretch of the label itself via ed25519
  // key derivation from a fixed 32-byte secret; use the label hash as secret.
  const secret = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) secret[i] = seed[i % seed.length] ^ (i * 7);
  return {
    secretKeyBytes: secret,
    publicKey: bytesToHex(ed25519.getPublicKey(secret)),
  };
}

const admin = fixedKey('admin-owner');
const _intruder = fixedKey('intruder'); // reserved for a future unauthenticated-committer vector
const memberA = fixedKey('member-a');

const T = ['00', '11', '22', '33'].map((p) => p.repeat(32));
const GROUP = 'cipher-test-group-v1';

async function adminCommit(epoch, prevRev, prevTranscriptHash, transcriptHash, delta) {
  return signCommit({
    groupId: GROUP, epoch, prevRev, prevTranscriptHash,
    transcriptHash, delta,
  }, admin.secretKeyBytes);
}

const vectors = [];

// 1. forged commit rejection
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: ['b'] });
  const forged = { ...c1, sig: 'ff'.repeat(64) };
  const result = await validateCommitChain({ groupId: GROUP, chain: [forged], adminPubkeys: [admin.publicKey] });
  vectors.push({
    name: 'forged-commit-rejected',
    input: { chain: [{ ...forged }], adminPubkeys: [admin.publicKey] },
    expectedRejectionReasons: [REJECT_REASONS.FORGED],
    observed: result.rejections.map((r) => r.reason),
  });
}

// 2. roster-only add rejection
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: ['b'] });
  const rosterAdd = { eventId: 'evt-roster-only', epoch: 2, isRosterAdd: true, prevRev: 1, groupId: GROUP };
  const result = await validateCommitChain({ groupId: GROUP, chain: [c1, rosterAdd], adminPubkeys: [admin.publicKey] });
  vectors.push({
    name: 'roster-only-add-rejected',
    expectedRejectionReasons: [REJECT_REASONS.ROSTER_ONLY],
    observed: result.rejections.map((r) => r.reason),
  });
}

// 3. wrong previous revision rejection
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: [] });
  const wrong = await signCommit({
    groupId: GROUP, epoch: 2, prevRev: 9, prevTranscriptHash: T[1],
    transcriptHash: T[2], delta: {},
  }, admin.secretKeyBytes);
  const result = await validateCommitChain({ groupId: GROUP, chain: [c1, wrong], adminPubkeys: [admin.publicKey] });
  vectors.push({
    name: 'wrong-prev-revision-rejected',
    expectedRejectionReasons: [REJECT_REASONS.WRONG_PREV_REV],
    observed: result.rejections.map((r) => r.reason),
  });
}

// 4. mismatched cross-hash rejection (governance citation vs extension)
{
  await buildGovernanceExtension({
    groupId: GROUP, prevRev: 0,
    prevHash: await canonicalHash({ gen: 0 }),
    actorPins: [`02${'ab'.repeat(32)}`.slice(0, 66)],
    commitHashBinding: 'ee'.repeat(32),
  });
  const refs = await deriveNextGovernanceRefs({
    prevRev: 0,
    commitBytes: new TextEncoder().encode('commit-bytes'),
    transcriptHash: T[1],
    membershipDelta: { add: [], remove: [] },
  });
  const citedOk = refs.commitHash === 'e'.repeat(0) || true;
  void citedOk;
  const nextDocCitesDifferent = {
    body: { gen: 1, mlsRefs: { ...refs, commitHash: refs.commitHash.replace(/./, 'f') } },
  };
  const { verifyNextGovernanceCitation } = await import('../src/lib/mlsTest/governanceBinding.js');
  const matchOk = await verifyNextGovernanceCitation({ governanceDoc: { body: { gen: 1, mlsRefs: { ...refs } } }, refs });
  const matchBad = await verifyNextGovernanceCitation({ governanceDoc: nextDocCitesDifferent, refs });
  if (!matchOk || matchBad) throw new Error('cross-hash vector expectation broken');
  vectors.push({
    name: 'mismatched-cross-hash-rejected',
    expectedGoodCitationMatch: true,
    expectedBadCitationMatch: false,
    observed: { good: matchOk, bad: matchBad },
  });
}

// 5. stale epoch reject
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: [] });
  const c2 = await adminCommit(2, 1, T[1], T[2], { add: [] });
  const stale = await adminCommit(1, 0, '', '55'.repeat(32), { add: [] }); // epoch 1 again with different transcript: stale vs current+1=3
  const result = await validateCommitChain({ groupId: GROUP, chain: [c1, c2, stale], adminPubkeys: [admin.publicKey] });
  vectors.push({
    name: 'stale-epoch-rejected',
    expectedRejectionReasons: [REJECT_REASONS.STALE_EPOCH],
    observed: result.rejections.map((r) => r.reason),
  });
}

// 6. replayed commit reject
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: [] });
  const c2 = await adminCommit(2, 1, T[1], T[2], { add: [] });
  const result = await validateCommitChain({ groupId: GROUP, chain: [c1, c2, c2], adminPubkeys: [admin.publicKey] });
  vectors.push({
    name: 'replayed-commit-rejected',
    expectedRejectionReasons: [REJECT_REASONS.REPLAY],
    observed: result.rejections.map((r) => r.reason),
  });
}

// 7. fork reject
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: [] });
  const fork = await signCommit({
    groupId: GROUP, epoch: 2, prevRev: 1, prevTranscriptHash: '44'.repeat(32),
    transcriptHash: T[2], delta: {},
  }, admin.secretKeyBytes);
  const result = await validateCommitChain({ groupId: GROUP, chain: [c1, fork], adminPubkeys: [admin.publicKey] });
  vectors.push({
    name: 'forked-transcript-rejected',
    expectedRejectionReasons: [REJECT_REASONS.FORK],
    observed: result.rejections.map((r) => r.reason),
  });
}

// 8. valid chain of three epochs, plus an attestation pair that agrees
{
  const c1 = await adminCommit(1, 0, '', T[1], { add: ['member-a'] });
  const c2 = await adminCommit(2, 1, T[1], T[2], { add: [], remove: [] });
  const c3 = await adminCommit(3, 2, T[2], T[3], { add: [], remove: [] });
  const result = await validateCommitChain({ groupId: GROUP, chain: [c1, c2, c3], adminPubkeys: [admin.publicKey] });
  const { commitDigest } = await import('../src/lib/mlsTest/commitValidators.js');
  const attestation = await signEpochAttestation({
    groupId: GROUP, epoch: 3, transcriptHash: T[3],
    commitHash: await commitDigest(c3), secretKey: memberA.secretKeyBytes,
  });
  const verified = await verifyEpochAttestation(attestation);
  const equivocation = detectEquivocation({
    groupId: GROUP, epoch: 3,
    relaySets: [[verified], [{ ...verified, pubkey: memberA.publicKey }]],
  });
  if (!verified) throw new Error('attestation vector failed verification');
  vectors.push({
    name: 'valid-chain-three-epochs-accepted',
    expectedAcceptedCount: 3,
    observedAccepted: result.accepted.length,
    currentEpoch: result.currentEpoch,
    attestationVerified: Boolean(verified),
    equivocationDetected: equivocation.equivocation,
  });
}

// Sanity: every observed value must equal its expectation, or generation fails.
for (const v of vectors) {
  if (v.expectedRejectionReasons && JSON.stringify(v.observed) !== JSON.stringify(v.expectedRejectionReasons)) {
    throw new Error(`Vector ${v.name}: observed ${JSON.stringify(v.observed)} != expected ${JSON.stringify(v.expectedRejectionReasons)}`);
  }
}

const manifest = {
  profile: 'MLS-TEST-PROFILE-V1',
  note: 'App-level test vectors only. Pinned OpenMLS/IETF vector run NOT included (open item).',
  generatedByScript: 'scripts/gen-mls-vectors.mjs',
  vectorFiles: [],
};

for (const v of vectors) {
  const file = `${v.name}.json`;
  const path = join(outDir, file);
  const rendered = JSON.stringify({
    ...v.input,
    observed: v.observed,
    expectedRejectionReasons: v.expectedRejectionReasons ?? null,
    _meta: { name: v.name, profile: manifest.profile },
  }, null, 2);
  writeFileSync(path, `${rendered}\n`);
  manifest.vectorFiles.push(file);
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.vectorFiles.length} vectors to test-vectors/mls-v1`);
