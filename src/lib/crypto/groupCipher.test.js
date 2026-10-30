import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptGroupMessage, encryptGroupMessage, generateGroupKey } from './groupCipher.js';

const groupId = 'group-aad';
const sender = 'a'.repeat(64);

test('group messages round-trip and reject a tampered AAD, epoch, or key', async () => {
  const key = generateGroupKey();
  const other = generateGroupKey();
  const envelope = await encryptGroupMessage({
    rawKey: key,
    plaintext: 'hello group',
    groupId,
    epoch: 3,
    senderPubkey: sender,
  });
  assert.equal(await decryptGroupMessage({
    rawKey: key, envelope, groupId, epoch: 3, senderPubkey: sender,
  }), 'hello group');

  await assert.rejects(() => decryptGroupMessage({
    rawKey: key, envelope, groupId: 'other-group', epoch: 3, senderPubkey: sender,
  }));
  await assert.rejects(() => decryptGroupMessage({
    rawKey: key, envelope, groupId, epoch: 4, senderPubkey: sender,
  }));
  await assert.rejects(() => decryptGroupMessage({
    rawKey: key, envelope, groupId, epoch: 3, senderPubkey: 'b'.repeat(64),
  }));
  await assert.rejects(() => decryptGroupMessage({
    rawKey: other, envelope, groupId, epoch: 3, senderPubkey: sender,
  }));
});
