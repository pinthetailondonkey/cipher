import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash } from './governanceBinding.js';
import { STATES, createReceiverStateMachine } from './receiverBuffer.js';
import {
  buildGovernanceExtension,
} from './governanceBinding.js';

const PIN = '0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203a1';
const COMMIT_HASH = 'ab'.repeat(32);
void 0; // unused

const docBody = () => ({ gen: 7, members: [{ pubkey: 'admin-actor', role: 'admin', gen: 2 }] });

const validPair = async () => ({
  commit: {
    commitHashBinding: COMMIT_HASH,
    governanceExtension: await buildGovernanceExtension({
      groupId: 'g1',
      prevRev: 7,
      prevHash: await canonicalHash(docBody()),
      actorPins: [PIN],
      commitHashBinding: COMMIT_HASH,
    }),
    signerActor: 'admin-actor',
  },
  governance: { body: docBody(), nextRefs: null },
});

test('a receiver grants nothing until both the commit and the governance document arrive', async () => {
  const m = createReceiverStateMachine({ groupId: 'g1' });
  const pair = await validPair();
  assert.equal(m.receive('commit', pair.commit), STATES.BUFFERING);
  assert.equal(await m.tryVerify(), STATES.BUFFERING); // one side missing
  assert.equal(m.receive('governance', pair.governance), STATES.BUFFERING);
  assert.equal(await m.tryVerify(), STATES.VERIFIED);
});

test('a mismatched cross-hash between the two buffered events rejects the pair', async () => {
  const m = createReceiverStateMachine({ groupId: 'g1' });
  const pair = await validPair();
  // The next document must cite the SAME commit hash; give it a wrong one.
  pair.governance.nextRefs = { commitHash: 'ff'.repeat(32) };
  m.receive('commit', pair.commit);
  m.receive('governance', pair.governance);
  assert.equal(await m.tryVerify(), STATES.REJECTED);
  assert.ok(m.rejections.some((r) => r.reason === 'cross-hash-mismatch'));
});

test('a second conflicting commit while one is pending is a rejection, not a silent replace', async () => {
  const m = createReceiverStateMachine({ groupId: 'g1' });
  const pair = await validPair();
  m.receive('commit', pair.commit);
  m.receive('commit', { ...pair.commit, commitHashBinding: 'ee'.repeat(32) });
  assert.equal(m.state, STATES.REJECTED);
});

test('events arriving after a rejection are held in the buffer, not applied', async () => {
  const m = createReceiverStateMachine({ groupId: 'g1' });
  const pair = await validPair();
  m.receive('commit', pair.commit);
  m.receive('governance', { body: { gen: 999 }, nextRefs: null }); // invalid doc -> reject
  assert.equal(await m.tryVerify(), STATES.REJECTED);
  const before = m.buffered.length;
  m.receive('governance', { body: docBody() });
  assert.equal(m.buffered.length, before + 1);
  assert.equal(m.state, STATES.REJECTED);
});

test('an equivocation alert freezes the group until owner recovery', async () => {
  const m = createReceiverStateMachine({ groupId: 'g1' });
  const pair = await validPair();
  m.receive('commit', pair.commit);
  m.receive('governance', pair.governance);
  m.freeze({ reason: 'transcript-divergence-across-relays' });
  assert.equal(m.state, STATES.FROZEN);
});
