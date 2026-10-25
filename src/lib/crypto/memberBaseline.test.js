import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  decryptMemberBaselines,
  memberBaselineTag,
  removedSinceBaseline,
  sealMemberBaseline,
} from './memberBaseline.js';
import { reconcileRunKey } from './groupKeyRotation.js';

test('a reinstall that recovers the baseline still sees who left', () => {
  const owner = 'o'.repeat(64);
  const before = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  const after = ['a'.repeat(64), 'b'.repeat(64)];
  assert.deepEqual(removedSinceBaseline(before, after), ['c'.repeat(64)]);
  assert.deepEqual(removedSinceBaseline(null, after), []);
  assert.deepEqual(removedSinceBaseline(after, after), []);
  assert.notEqual(reconcileRunKey(`${before.join(',')}|${owner}`, 1), reconcileRunKey(`${after.join(',')}|${owner}`, 2));
  assert.notEqual(reconcileRunKey(`${before.join(',')}|${owner}`, 1), reconcileRunKey(`${before.join(',')}|${owner}`, 2));
  assert.equal(reconcileRunKey(`${after.join(',')}|${owner}`, 2), reconcileRunKey(`${after.join(',')}|${owner}`, 2));
});

test('the published baseline round-trips and an older copy does not win', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const groupId = 'group-1';
  const older = await sealMemberBaseline({
    senderPrivkey: sk, senderPubkey: pk, groupId, members: ['a', 'b', 'c'], at: 100,
  });
  const newer = await sealMemberBaseline({
    senderPrivkey: sk, senderPubkey: pk, groupId, members: ['a', 'b'], at: 200,
  });
  assert.equal(older.kind, 30078);
  assert.equal(older.tags.find((tag) => tag[0] === 'd')[1], memberBaselineTag(groupId));
  const picked = await decryptMemberBaselines([older, newer], sk, pk, groupId);
  assert.deepEqual(picked.members, ['a', 'b']);
  assert.equal(picked.at, 200);
  assert.equal(await decryptMemberBaselines([older], sk, pk, 'other-group'), null);
});
