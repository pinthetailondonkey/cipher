import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { decryptGroupMessage, encryptGroupMessage, fromHex, generateGroupKey } from './groupCipher.js';
import { REGRANT_WINDOW_SEC, distributeGroupKey, epochsToBackfill, epochsToSend, installFloorAllows, missingEpochs, parseGroupKeyBundle } from './groupKeyDistribution.js';

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

// Bug #9: the ledger recorded a send, the member refused the unsolicited
// bundle (it had not asked), and its own request was then skipped as
// "already granted" - the composer sat on Securing forever.
function memoryLedger() {
  const rows = new Map();
  return {
    rows,
    getGrantRecords: async (gid, pk) => new Map([...rows].filter(([k]) => k.startsWith(`${gid}|${pk}|`))
      .map(([k, v]) => [Number(k.split('|')[2]), v])),
    recordGrant: async (gid, pk, ep, { answered = false } = {}) => {
      const key = `${gid}|${pk}|${ep}`;
      const held = rows.get(key) || {};
      rows.set(key, { sentAt: Math.floor(Date.now() / 1000), ...(answered ? { answeredAt: Math.floor(Date.now() / 1000) } : held.answeredAt ? { answeredAt: held.answeredAt } : {}) });
    },
  };
}

test('epochsToSend: an unsolicited send skips the ledger, an explicit request does not, and answers are rate limited', () => {
  const extras = [{ epoch: 1, bytes: new Uint8Array(32) }];
  const records = new Map([[2, { sentAt: 100 }], [1, { sentAt: 100 }]]);
  // Unsolicited: both epochs are in the ledger, nothing to send (unchanged).
  assert.deepEqual(epochsToSend({ records, epoch: 2, extraEpochs: extras, explicit: false, nowSec: 110 }), []);
  // A request is answered although the ledger says both were sent.
  assert.deepEqual(epochsToSend({ records, epoch: 2, extraEpochs: extras, explicit: true, nowSec: 110 }), [2, 1]);
  // After an answer, a repeat inside the window sends nothing; after it, it sends again.
  const answered = new Map([[2, { sentAt: 100, answeredAt: 100 }], [1, { sentAt: 100, answeredAt: 100 }]]);
  assert.deepEqual(epochsToSend({ records: answered, epoch: 2, extraEpochs: extras, explicit: true, nowSec: 100 + REGRANT_WINDOW_SEC - 1 }), []);
  assert.deepEqual(epochsToSend({ records: answered, epoch: 2, extraEpochs: extras, explicit: true, nowSec: 100 + REGRANT_WINDOW_SEC }), [2, 1]);
});

test('approve-then-ask: the unsolicited key is refused by the member, and the request that follows still ends with the member holding the key', async () => {
  const ownerSk = generateSecretKey();
  const ownerPk = getPublicKey(ownerSk);
  const memberSk = generateSecretKey();
  const memberPk = getPublicKey(memberSk);
  const groupId = 'group-bug9';
  const key = generateGroupKey();
  const ledger = memoryLedger();
  const wire = [];
  const send = (answerRequest) => distributeGroupKey({
    senderPrivkey: ownerSk, senderPubkey: ownerPk, groupId, epoch: 1, keyBytes: key,
    recipients: [memberPk], answerRequest, ledger, publish: async (event) => { wire.push(event); },
  });
  // The member's device: keyless, and has not asked yet.
  let memberKey = null;
  let asked = false;
  const receive = (event) => {
    if (!installFloorAllows({ hasKey: Boolean(memberKey), asked })) return false;
    const payload = JSON.parse(nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(memberSk, event.pubkey)));
    memberKey = fromHex(parseGroupKeyBundle(payload)[0].hex);
    return true;
  };

  // 1. Owner approves the member: the unsolicited bundle goes out and is recorded.
  await send(false);
  assert.equal(wire.length, 1);
  assert.equal(receive(wire[0]), false, 'the unsolicited key is refused: this device has not asked');
  assert.equal(memberKey, null);
  // The unsolicited send alone is now in the ledger, and a second unsolicited send is skipped (unchanged rule).
  await send(false);
  assert.equal(wire.length, 1);
  // 2. The member asks. The owner answers the explicit request although the ledger says "granted".
  asked = true;
  await send(true);
  assert.equal(wire.length, 2, 'the request is answered, not skipped');
  assert.equal(receive(wire[1]), true);
  assert.deepEqual(memberKey, key, 'the member holds the key');
  // 3. A request repeated at once is rate limited, not an amplifier.
  await send(true);
  assert.equal(wire.length, 2);
  // The key still decrypts what the group sends under it.
  const envelope = await encryptGroupMessage({ rawKey: key, plaintext: 'hello', groupId, epoch: 1, senderPubkey: ownerPk });
  assert.equal(await decryptGroupMessage({ rawKey: memberKey, envelope, groupId, epoch: 1, senderPubkey: ownerPk }), 'hello');
});
