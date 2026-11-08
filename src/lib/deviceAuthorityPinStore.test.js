import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  createDeviceAuthoritySetup, replaceDeviceAuthority,
} from './deviceAuthority.js';
import {
  advanceDeviceAuthorityPolicyPin, loadPinnedDeviceAuthorityPolicy, pinInitialDeviceAuthorityPolicy,
} from './deviceAuthorityPinStore.js';

const now = 1_800_000_000;

test('policy pinning requires an independently authenticated recovery key and preserves the exact local head', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const expectedRecoveryPubkey = getPublicKey(state.recoverySecret);
  await assert.rejects(pinInitialDeviceAuthorityPolicy({
    policyEvent: state.policyEvent, expectedAccountPubkey: state.policyEvent.content && JSON.parse(state.policyEvent.content).accountPubkey,
    expectedRecoveryPubkey: getPublicKey(generateSecretKey()), now,
  }), /does not match/i);

  const pinned = await pinInitialDeviceAuthorityPolicy({
    policyEvent: state.policyEvent, expectedAccountPubkey: JSON.parse(state.policyEvent.content).accountPubkey,
    expectedRecoveryPubkey, now,
  });
  assert.equal(pinned.policyId, state.policyEvent.id);
  const loaded = await loadPinnedDeviceAuthorityPolicy({
    expectedAccountPubkey: JSON.parse(state.policyEvent.content).accountPubkey, expectedRecoveryPubkey, now,
  });
  assert.equal(loaded.policyId, state.policyEvent.id);
  assert.equal(loaded.recoveryPubkey, expectedRecoveryPubkey);
  assert.equal((await pinInitialDeviceAuthorityPolicy({
    policyEvent: state.policyEvent, expectedAccountPubkey: loaded.policyEvent.content && JSON.parse(loaded.policyEvent.content).accountPubkey,
    expectedRecoveryPubkey, now,
  })).idempotent, true);
  await assert.rejects(pinInitialDeviceAuthorityPolicy({
    policyEvent: state.policyEvent, expectedAccountPubkey: loaded.policyEvent.pubkey,
    expectedRecoveryPubkey, now,
  }), /does not match|account/i, 'the recovery root is not the Nostr account key');
});

test('policy replacement advances exactly once, retries safely, and rejects a stale relay policy', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const expectedAccountPubkey = JSON.parse(state.policyEvent.content).accountPubkey;
  const expectedRecoveryPubkey = getPublicKey(state.recoverySecret);
  const replacement = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 1 });
  await pinInitialDeviceAuthorityPolicy({ policyEvent: state.policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now });
  const advanced = await advanceDeviceAuthorityPolicyPin({
    currentPolicyEvent: state.policyEvent, nextPolicyEvent: replacement.policyEvent,
    expectedAccountPubkey, expectedRecoveryPubkey, now: now + 1,
  });
  assert.equal(advanced.policyId, replacement.policyEvent.id);
  assert.equal(advanced.authorityEpoch, 2);
  const retry = await advanceDeviceAuthorityPolicyPin({
    currentPolicyEvent: state.policyEvent, nextPolicyEvent: replacement.policyEvent,
    expectedAccountPubkey, expectedRecoveryPubkey, now: now + 2,
  });
  assert.equal(retry.idempotent, true, 'an interrupted relay delivery can retry the exact committed successor');

  await assert.rejects(pinInitialDeviceAuthorityPolicy({
    policyEvent: state.policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now: now + 2,
  }), /changed|interrupted/i, 'a relay cannot roll the initial pin back');
  await assert.rejects(advanceDeviceAuthorityPolicyPin({
    currentPolicyEvent: replacement.policyEvent, nextPolicyEvent: state.policyEvent,
    expectedAccountPubkey, expectedRecoveryPubkey, now: now + 2,
  }), /successor/i, 'a stale relay policy cannot become a successor');
  const loaded = await loadPinnedDeviceAuthorityPolicy({ expectedAccountPubkey, expectedRecoveryPubkey, now: now + 2 });
  assert.equal(loaded.policyId, replacement.policyEvent.id);
  assert.equal(loaded.authorityEpoch, 2);
});

test('a compromised authority cannot move the recovery pin, and concurrent recovery forks cannot both win', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const expectedAccountPubkey = JSON.parse(state.policyEvent.content).accountPubkey;
  const expectedRecoveryPubkey = getPublicKey(state.recoverySecret);
  const replacementA = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 1 });
  const replacementB = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 2 });
  const forgedByAuthority = finalizeEvent({
    kind: replacementA.policyEvent.kind, created_at: replacementA.policyEvent.created_at,
    tags: replacementA.policyEvent.tags, content: replacementA.policyEvent.content,
  }, state.authoritySecret);

  await pinInitialDeviceAuthorityPolicy({ policyEvent: state.policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now });
  await assert.rejects(advanceDeviceAuthorityPolicyPin({
    currentPolicyEvent: state.policyEvent, nextPolicyEvent: forgedByAuthority,
    expectedAccountPubkey, expectedRecoveryPubkey, now: now + 3,
  }), /successor/i, 'the primary authority cannot forge a recovery-signed policy update');

  const race = await Promise.allSettled([
    advanceDeviceAuthorityPolicyPin({ currentPolicyEvent: state.policyEvent, nextPolicyEvent: replacementA.policyEvent,
      expectedAccountPubkey, expectedRecoveryPubkey, now: now + 3 }),
    advanceDeviceAuthorityPolicyPin({ currentPolicyEvent: state.policyEvent, nextPolicyEvent: replacementB.policyEvent,
      expectedAccountPubkey, expectedRecoveryPubkey, now: now + 3 }),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
  const loaded = await loadPinnedDeviceAuthorityPolicy({ expectedAccountPubkey, expectedRecoveryPubkey, now: now + 4 });
  assert.ok([replacementA.policyEvent.id, replacementB.policyEvent.id].includes(loaded.policyId));
});

test('keeping the same Nostr account identity does not authenticate a replacement recovery authority', async () => {
  const accountPubkey = getPublicKey(generateSecretKey());
  const original = createDeviceAuthoritySetup({ accountPubkey, now });
  const attacker = createDeviceAuthoritySetup({ accountPubkey, now: now + 1 });
  const pinnedRecoveryPubkey = getPublicKey(original.recoverySecret);
  const attackerRecoveryPubkey = getPublicKey(attacker.recoverySecret);
  assert.equal(JSON.parse(original.policyEvent.content).accountPubkey,
    JSON.parse(attacker.policyEvent.content).accountPubkey, 'profile and Nostr identity remain the same');
  assert.notEqual(pinnedRecoveryPubkey, attackerRecoveryPubkey);

  await assert.rejects(pinInitialDeviceAuthorityPolicy({ policyEvent: attacker.policyEvent,
    expectedAccountPubkey: accountPubkey, expectedRecoveryPubkey: pinnedRecoveryPubkey, now: now + 2 }),
  /does not match/i, 'a same-N account signature/profile cannot silently TOFU a new device authority');
  assert.throws(() => replaceDeviceAuthority({ currentPolicyEvent: original.policyEvent,
    recoverySecret: attacker.recoverySecret, now: now + 2 }), /cannot authenticate/i,
  'the replacement recovery secret must be the already pinned root');
});
