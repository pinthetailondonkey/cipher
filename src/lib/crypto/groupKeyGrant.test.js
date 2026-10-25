import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { decryptGroupMessage, encryptGroupMessage, fromHex, generateGroupKey } from './groupCipher.js';
import { distributeGroupKey, epochsToBackfill, missingEpochs, parseGroupKeyBundle } from './groupKeyDistribution.js';

test('a key request backfills every epoch the requester missed, not only the current one', () => {
  const current = { epoch: 3, bytes: new Uint8Array(32) };
  const skipped = [{ epoch: 1, bytes: new Uint8Array(32) }, { epoch: 2, bytes: new Uint8Array(32) }, current];
  assert.deepEqual(epochsToBackfill(skipped, 3).map((item) => item.epoch), [1, 2]);
  assert.deepEqual(epochsToBackfill([current], 3), []);
});

test('grant tracking asks only for epochs the recipient does not already have', () => {
  const granted = new Set([1]);
  const extras = [{ epoch: 1, bytes: new Uint8Array(32) }, { epoch: 2, bytes: new Uint8Array(32) }];
  assert.deepEqual(missingEpochs(granted, 3, extras), [3, 2]);
  granted.add(2);
  granted.add(3);
  assert.deepEqual(missingEpochs(granted, 3, extras), []);
  assert.deepEqual(missingEpochs(new Set(), 2, [{ epoch: 2, bytes: new Uint8Array(32) }]), [2]);
});

test('a received key bundle is the epoch list, and a bad hex is dropped', () => {
  const hex = 'ab'.repeat(32);
  assert.deepEqual(parseGroupKeyBundle({
    t: 'gkey', gid: 'g1', keys: [{ ep: 2, k: hex }, { ep: 1, k: 'zz' }],
  }), [{ groupId: 'g1', epoch: 2, hex }]);
  assert.deepEqual(parseGroupKeyBundle({ type: 'text', message: 'hi' }), []);
});

test('a member offline across two rotations still receives every epoch and can decrypt both', async () => {
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);
  const groupId = 'group-backfill';
  const epochOne = generateGroupKey();
  const epochTwo = generateGroupKey();
  const first = await encryptGroupMessage({
    rawKey: epochOne, plaintext: 'kept from epoch 1', groupId, epoch: 1, senderPubkey: senderPk,
  });
  const second = await encryptGroupMessage({
    rawKey: epochTwo, plaintext: 'new after rotation', groupId, epoch: 2, senderPubkey: senderPk,
  });

  const published = [];
  await distributeGroupKey({
    senderPrivkey: senderSk,
    senderPubkey: senderPk,
    groupId,
    epoch: 2,
    keyBytes: epochTwo,
    recipients: [recipientPk],
    extraEpochs: [{ epoch: 1, bytes: epochOne }],
    publish: async (event) => { published.push(event); },
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 4);

  const shared = nip44.v2.utils.getConversationKey(recipientSk, senderPk);
  const payload = JSON.parse(nip44.v2.decrypt(published[0].content, shared));
  const keys = new Map(payload.keys.map((item) => [item.ep, fromHex(item.k)]));
  assert.equal(keys.size, 2);
  assert.equal(await decryptGroupMessage({
    rawKey: keys.get(1), envelope: first, groupId, epoch: 1, senderPubkey: senderPk,
  }), 'kept from epoch 1');
  assert.equal(await decryptGroupMessage({
    rawKey: keys.get(2), envelope: second, groupId, epoch: 2, senderPubkey: senderPk,
  }), 'new after rotation');

  await assert.rejects(() => decryptGroupMessage({
    rawKey: keys.get(2), envelope: first, groupId, epoch: 1, senderPubkey: senderPk,
  }));
});

test('a rejected key delivery fails instead of pretending the grant was sent', async () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  await assert.rejects(() => distributeGroupKey({
    senderPrivkey: senderSk,
    senderPubkey: getPublicKey(senderSk),
    groupId: 'group-fail',
    epoch: 1,
    keyBytes: generateGroupKey(),
    recipients: [getPublicKey(recipientSk)],
    publish: async () => { throw new Error('relay rejected'); },
  }), /Could not distribute group keys/);
});
