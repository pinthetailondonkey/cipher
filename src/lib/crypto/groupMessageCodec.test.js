import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGroupEvent } from './groupMessageCodec.js';
import { encryptGroupMessage, generateGroupKey } from './groupCipher.js';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';

const GROUP = 'codec-group';
const SENDER = 'a'.repeat(64);

// A key store in memory: the codec reads keys through an injected store, so
// the rule is tested without a database.
function storeHolding(keys) {
  return {
    getGroupKey: async (_gid, epoch) => keys.get(epoch) || null,
    getCurrentGroupKey: async () => {
      if (!keys.size) return null;
      const epoch = Math.max(...keys.keys());
      return { epoch, bytes: keys.get(epoch) };
    },
  };
}
const ev = (content, tags = []) => ({ content, tags, pubkey: SENDER, kind: 9 });
const decodeForCipherTest = (args) => decodeGroupEvent({ ...args, requireMember: false });

test('a tagless kind-9 in a group that holds a key is refused, not shown as plaintext', async () => {
  const store = storeHolding(new Map([[1, generateGroupKey()]]));
  const forged = ev(JSON.stringify({ type: 'text', message: 'send the coins to me' }));
  const out = await decodeForCipherTest({ event: forged, groupId: GROUP, store });
  assert.equal(out.refused, true);
  assert.equal(out.error, 'unencrypted-refused');
  assert.equal(out.plaintext, undefined);
  assert.equal(out.parsed, undefined);
  // Bare text with no JSON is refused the same way.
  const bare = await decodeForCipherTest({ event: ev('hello'), groupId: GROUP, store });
  assert.equal(bare.refused, true);
});

test('a tagless kind-9 in a group with no key is a legacy message and still reads', async () => {
  const store = storeHolding(new Map());
  const out = await decodeForCipherTest({ event: ev('old hello'), groupId: GROUP, store });
  assert.equal(out.legacy, true);
  assert.equal(out.plaintext, 'old hello');
  assert.deepEqual(out.parsed, { type: 'text', message: 'old hello' });
});

test('the plaintext key request still decodes as a control body in a keyed group', async () => {
  const store = storeHolding(new Map([[0, generateGroupKey()]]));
  const out = await decodeForCipherTest({ event: ev(JSON.stringify({ type: 'gkey_req' })), groupId: GROUP, store });
  assert.equal(out.parsed.type, 'gkey_req');
  assert.equal(out.refused, undefined);
});

test('an encrypted message still round-trips, and the AAD binding is unchanged', async () => {
  const key = generateGroupKey();
  const store = storeHolding(new Map([[2, key]]));
  const envelope = await encryptGroupMessage({
    rawKey: key, plaintext: JSON.stringify({ type: 'text', message: 'hi' }), groupId: GROUP, epoch: 2, senderPubkey: SENDER,
  });
  const out = await decodeForCipherTest({ event: ev(JSON.stringify(envelope), [['ep', '2']]), groupId: GROUP, store });
  assert.deepEqual(out.parsed, { type: 'text', message: 'hi' });
  // Same envelope, different claimed sender: the AAD refuses it.
  const spoofed = { ...ev(JSON.stringify(envelope), [['ep', '2']]), pubkey: 'b'.repeat(64) };
  assert.equal((await decodeForCipherTest({ event: spoofed, groupId: GROUP, store })).error, 'decrypt-failed');
  // A missing epoch key is pending, and a junk epoch tag is an error, not a throw.
  assert.equal((await decodeForCipherTest({ event: ev(JSON.stringify(envelope), [['ep', '9']]), groupId: GROUP, store })).pending, true);
  assert.equal((await decodeForCipherTest({ event: ev('{}', [['ep', 'x']]), groupId: GROUP, store })).error, 'decrypt-failed');
});

test('a group-key holder outside current governance standing cannot inject or replay a message', async () => {
  const key = generateGroupKey();
  const store = storeHolding(new Map([[1, key], [2, key]]));
  const removedSk = generateSecretKey();
  const removedActor = getPublicKey(removedSk);
  const envelope = await encryptGroupMessage({
    rawKey: key,
    plaintext: JSON.stringify({ type: 'text', message: 'forged after removal' }),
    groupId: GROUP,
    epoch: 1,
    senderPubkey: removedActor,
  });
  const event = finalizeEvent({
    kind: 9,
    created_at: 1,
    tags: [['h', GROUP], ['ep', '1']],
    content: JSON.stringify(envelope),
  }, removedSk);
  assert.equal(verifyEvent(event), true, 'the forged message has a valid independent Nostr signature');

  // The sender was removed from the current signed governance document. It
  // still has the old epoch key and may lie about created_at; neither should
  // turn the historical key into current message authority.
  const activeMembers = [{ pubkey: SENDER, role: 'admin' }];
  assert.equal((await decodeGroupEvent({ event, groupId: GROUP, store })).refused, true,
    'the decoder default also fails closed when callers omit governance standing');
  const early = await decodeGroupEvent({ event, groupId: GROUP, store, members: activeMembers, requireMember: true });
  const futureDated = await decodeGroupEvent({
    event: { ...event, created_at: Math.floor(Date.now() / 1000) + 10_000 },
    groupId: GROUP,
    store,
    members: activeMembers,
    requireMember: true,
  });
  assert.equal(early.refused, true);
  assert.equal(futureDated.refused, true);
  assert.equal(early.plaintext, undefined);
  assert.equal(futureDated.plaintext, undefined);

  // A currently authorized member's legitimate historical ciphertext remains
  // readable from its old epoch key.
  const activeSk = generateSecretKey();
  const activePk = getPublicKey(activeSk);
  const activeEnvelope = await encryptGroupMessage({
    rawKey: key,
    plaintext: JSON.stringify({ type: 'text', message: 'legitimate old history' }),
    groupId: GROUP,
    epoch: 1,
    senderPubkey: activePk,
  });
  const activeEvent = finalizeEvent({
    kind: 9,
    created_at: 1,
    tags: [['h', GROUP], ['ep', '1']],
    content: JSON.stringify(activeEnvelope),
  }, activeSk);
  const historical = await decodeGroupEvent({
    event: activeEvent,
    groupId: GROUP,
    store,
    members: [{ pubkey: activePk, role: 'member' }],
    requireMember: true,
  });
  assert.equal(historical.parsed.message, 'legitimate old history');
});

test('signed group messages bind one exact group id and reject ambiguous epoch tags', async () => {
  const key = generateGroupKey();
  const senderSk = generateSecretKey();
  const sender = getPublicKey(senderSk);
  const store = storeHolding(new Map([[3, key]]));
  const envelope = await encryptGroupMessage({
    rawKey: key,
    plaintext: JSON.stringify({ type: 'text', message: 'bound group' }),
    groupId: GROUP,
    epoch: 3,
    senderPubkey: sender,
  });
  const members = [{ pubkey: sender, role: 'member' }];
  const eventFor = (tags) => finalizeEvent({
    kind: 9,
    created_at: 10,
    tags,
    content: JSON.stringify(envelope),
  }, senderSk);

  const valid = await decodeGroupEvent({
    event: eventFor([['h', GROUP], ['ep', '3']]),
    groupId: GROUP,
    store,
    members,
    requireMember: true,
  });
  assert.equal(valid.parsed.message, 'bound group');

  const wrongGroup = await decodeGroupEvent({
    event: eventFor([['h', 'another-group'], ['ep', '3']]),
    groupId: GROUP,
    store,
    members,
    requireMember: true,
  });
  assert.equal(wrongGroup.refused, true);
  assert.equal(wrongGroup.error, 'invalid-group-binding');

  const duplicateGroup = await decodeGroupEvent({
    event: eventFor([['h', GROUP], ['h', GROUP], ['ep', '3']]),
    groupId: GROUP,
    store,
    members,
    requireMember: true,
  });
  assert.equal(duplicateGroup.refused, true);

  const ambiguousEpoch = await decodeGroupEvent({
    event: eventFor([['h', GROUP], ['ep', '3'], ['ep', '4']]),
    groupId: GROUP,
    store,
    members,
    requireMember: true,
  });
  assert.equal(ambiguousEpoch.error, 'decrypt-failed');
  assert.equal(ambiguousEpoch.plaintext, undefined);
});

test('JSON bodies that are not objects become text bodies, on both paths', async () => {
  const key = generateGroupKey();
  const keyed = storeHolding(new Map([[1, key]]));
  const keyless = storeHolding(new Map());
  for (const body of ['null', '5', '[]', 'true', '"s"']) {
    const legacy = await decodeForCipherTest({ event: ev(body), groupId: GROUP, store: keyless });
    assert.equal(typeof legacy.parsed, 'object', body);
    assert.equal(Array.isArray(legacy.parsed), false, body);
    assert.equal(legacy.parsed.type, 'text', body);
    const envelope = await encryptGroupMessage({ rawKey: key, plaintext: body, groupId: GROUP, epoch: 1, senderPubkey: SENDER });
    const enc = await decodeForCipherTest({ event: ev(JSON.stringify(envelope), [['ep', '1']]), groupId: GROUP, store: keyed });
    assert.equal(typeof enc.parsed, 'object', body);
    assert.equal(Array.isArray(enc.parsed), false, body);
    assert.equal(enc.parsed.type, 'text', body);
  }
  const s = await decodeForCipherTest({ event: ev('"s"'), groupId: GROUP, store: keyless });
  assert.equal(s.parsed.message, 's');
  const five = await decodeForCipherTest({ event: ev('5'), groupId: GROUP, store: keyless });
  assert.equal(five.parsed.message, '5');
});
