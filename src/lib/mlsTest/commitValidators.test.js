import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REJECT_REASONS,
  signCommit,
  validateCommitChain,
} from './commitValidators.js';
import { newKey } from './testingKeys.js';

const T1 = 'bb'.repeat(32);
const T2 = 'cc'.repeat(32);
const T3 = 'dd'.repeat(32);

const mkChain = async () => {
  const admin = newKey();
  const c1 = await signCommit({
    groupId: 'g1', epoch: 1, prevRev: 0, prevTranscriptHash: '',
    transcriptHash: T1, delta: { add: ['b'] },
  }, admin.secretKey);
  const c2 = await signCommit({
    groupId: 'g1', epoch: 2, prevRev: 1, prevTranscriptHash: T1,
    transcriptHash: T2, delta: { add: [], remove: ['c'] },
  }, admin.secretKey);
  const c3 = await signCommit({
    groupId: 'g1', epoch: 3, prevRev: 2, prevTranscriptHash: T2,
    transcriptHash: T3, delta: { add: ['d'], remove: [] },
  }, admin.secretKey);
  return { admin, c1, c2, c3 };
};

test('a valid chain of three epochs is fully accepted', async () => {
  const { admin, c1, c2, c3 } = await mkChain();
  const result = await validateCommitChain({
    groupId: 'g1', chain: [c1, c2, c3], adminPubkeys: [admin.publicKey],
  });
  assert.equal(result.accepted.length, 3);
  assert.equal(result.currentEpoch, 3);
  assert.equal(result.currentTranscriptHash, T3);
});

test('a forged commit (bad signature) is rejected as forged-commit', async () => {
  const { admin, c1 } = await mkChain();
  const forged = { ...c1, sig: '00'.repeat(64) };
  const result = await validateCommitChain({
    groupId: 'g1', chain: [forged], adminPubkeys: [admin.publicKey],
  });
  assert.deepEqual(result.rejections.map((r) => r.reason), [REJECT_REASONS.FORGED]);
});

test('a roster-only membership claim without a commit signature is rejected', async () => {
  const { admin, c1 } = await mkChain();
  const rosterAdd = { eventId: 'evt-roster', epoch: 2, isRosterAdd: true, prevRev: 1 };
  const result = await validateCommitChain({
    groupId: 'g1', chain: [c1, rosterAdd], adminPubkeys: [admin.publicKey],
  });
  assert.deepEqual(result.rejections.map((r) => r.reason), [REJECT_REASONS.ROSTER_ONLY]);
  assert.equal(result.accepted.length, 1);
});

test('a commit citing the wrong previous revision is rejected', async () => {
  const { admin, c1 } = await mkChain();
  const wrongRev = await signCommit({
    groupId: 'g1', epoch: 2, prevRev: 5, prevTranscriptHash: T1,
    transcriptHash: T2, delta: {},
  }, admin.secretKey);
  const result = await validateCommitChain({
    groupId: 'g1', chain: [c1, wrongRev], adminPubkeys: [admin.publicKey],
  });
  assert.deepEqual(result.rejections.map((r) => r.reason), [REJECT_REASONS.WRONG_PREV_REV]);
});

test('a stale epoch commit and a replayed commit are both rejected', async () => {
  const { admin, c1, c2, c3 } = await mkChain();
  const stale = await signCommit({
    groupId: 'g1', epoch: 2, prevRev: 1, prevTranscriptHash: T1,
    transcriptHash: T2, delta: {},
  }, admin.secretKey); // after c3 the current epoch is 3, so epoch 2 is stale
  const result = await validateCommitChain({
    groupId: 'g1', chain: [c1, c2, c3, stale, c3], adminPubkeys: [admin.publicKey],
  });
  const reasons = result.rejections.map((r) => r.reason);
  assert.ok(reasons.includes(REJECT_REASONS.STALE_EPOCH));
  assert.ok(reasons.includes(REJECT_REASONS.REPLAY));
});

test('a fork with a mismatched previous transcript hash is rejected', async () => {
  const { admin, c1 } = await mkChain();
  const fork = await signCommit({
    groupId: 'g1', epoch: 2, prevRev: 1, prevTranscriptHash: 'ee'.repeat(32),
    transcriptHash: T2, delta: {},
  }, admin.secretKey);
  const result = await validateCommitChain({
    groupId: 'g1', chain: [c1, fork], adminPubkeys: [admin.publicKey],
  });
  assert.deepEqual(result.rejections.map((r) => r.reason), [REJECT_REASONS.FORK]);
});

test('a committer that is not an authorized admin at the revision is rejected', async () => {
  const intruder = newKey();
  const badCommit = await signCommit({
    groupId: 'g1', epoch: 1, prevRev: 0, prevTranscriptHash: '',
    transcriptHash: T1, delta: { add: ['e'] },
  }, intruder.secretKey);
  const result = await validateCommitChain({
    groupId: 'g1', chain: [badCommit], adminPubkeys: [newKey().publicKey],
  });
  assert.deepEqual(result.rejections.map((r) => r.reason), [REJECT_REASONS.UNAUTHORIZED_ROLE]);
});
