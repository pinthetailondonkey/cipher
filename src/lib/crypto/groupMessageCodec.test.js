import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGroupEvent, isGroupControlBody, isGroupControlRow } from './groupMessageCodec.js';
import { encryptGroupMessage, generateGroupKey } from './groupCipher.js';

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

test('a tagless kind-9 in a group that holds a key is refused, not shown as plaintext', async () => {
  const store = storeHolding(new Map([[1, generateGroupKey()]]));
  const forged = ev(JSON.stringify({ type: 'text', message: 'send the coins to me' }));
  const out = await decodeGroupEvent({ event: forged, groupId: GROUP, store });
  assert.equal(out.refused, true);
  assert.equal(out.error, 'unencrypted-refused');
  assert.equal(out.plaintext, undefined);
  assert.equal(out.parsed, undefined);
  // Bare text with no JSON is refused the same way.
  const bare = await decodeGroupEvent({ event: ev('hello'), groupId: GROUP, store });
  assert.equal(bare.refused, true);
});

test('a tagless kind-9 in a group with no key is a legacy message and still reads', async () => {
  const store = storeHolding(new Map());
  const out = await decodeGroupEvent({ event: ev('old hello'), groupId: GROUP, store });
  assert.equal(out.legacy, true);
  assert.equal(out.plaintext, 'old hello');
  assert.deepEqual(out.parsed, { type: 'text', message: 'old hello' });
});

test('the plaintext key request still decodes as a control body in a keyed group', async () => {
  const store = storeHolding(new Map([[0, generateGroupKey()]]));
  const out = await decodeGroupEvent({ event: ev(JSON.stringify({ type: 'gkey_req' })), groupId: GROUP, store });
  assert.equal(out.parsed.type, 'gkey_req');
  assert.equal(out.refused, undefined);
});

test('an encrypted message still round-trips, and the AAD binding is unchanged', async () => {
  const key = generateGroupKey();
  const store = storeHolding(new Map([[2, key]]));
  const envelope = await encryptGroupMessage({
    rawKey: key, plaintext: JSON.stringify({ type: 'text', message: 'hi' }), groupId: GROUP, epoch: 2, senderPubkey: SENDER,
  });
  const out = await decodeGroupEvent({ event: ev(JSON.stringify(envelope), [['ep', '2']]), groupId: GROUP, store });
  assert.deepEqual(out.parsed, { type: 'text', message: 'hi' });
  // Same envelope, different claimed sender: the AAD refuses it.
  const spoofed = { ...ev(JSON.stringify(envelope), [['ep', '2']]), pubkey: 'b'.repeat(64) };
  assert.equal((await decodeGroupEvent({ event: spoofed, groupId: GROUP, store })).error, 'decrypt-failed');
  // A missing epoch key is pending, and a junk epoch tag is an error, not a throw.
  assert.equal((await decodeGroupEvent({ event: ev(JSON.stringify(envelope), [['ep', '9']]), groupId: GROUP, store })).pending, true);
  assert.equal((await decodeGroupEvent({ event: ev('{}', [['ep', 'x']]), groupId: GROUP, store })).error, 'decrypt-failed');
});

test('JSON bodies that are not objects become text bodies, on both paths', async () => {
  const key = generateGroupKey();
  const keyed = storeHolding(new Map([[1, key]]));
  const keyless = storeHolding(new Map());
  for (const body of ['null', '5', '[]', 'true', '"s"']) {
    const legacy = await decodeGroupEvent({ event: ev(body), groupId: GROUP, store: keyless });
    assert.equal(typeof legacy.parsed, 'object', body);
    assert.equal(Array.isArray(legacy.parsed), false, body);
    assert.equal(legacy.parsed.type, 'text', body);
    const envelope = await encryptGroupMessage({ rawKey: key, plaintext: body, groupId: GROUP, epoch: 1, senderPubkey: SENDER });
    const enc = await decodeGroupEvent({ event: ev(JSON.stringify(envelope), [['ep', '1']]), groupId: GROUP, store: keyed });
    assert.equal(typeof enc.parsed, 'object', body);
    assert.equal(Array.isArray(enc.parsed), false, body);
    assert.equal(enc.parsed.type, 'text', body);
  }
  const s = await decodeGroupEvent({ event: ev('"s"'), groupId: GROUP, store: keyless });
  assert.equal(s.parsed.message, 's');
  const five = await decodeGroupEvent({ event: ev('5'), groupId: GROUP, store: keyless });
  assert.equal(five.parsed.message, '5');
});

test('a key request and a typing ping are control bodies, never chat messages', async () => {
  assert.equal(isGroupControlBody({ type: 'gkey_req' }), true);
  assert.equal(isGroupControlBody({ type: 'typing' }), true);
  assert.equal(isGroupControlBody({ type: 'text', message: 'gkey_req' }), false);
  assert.equal(isGroupControlBody({ type: 'system', message: 'x' }), false);
  assert.equal(isGroupControlBody(null), false);
  assert.equal(isGroupControlBody(undefined), false);
  // The key request really does decode as one, with no key held (its sender has none).
  const out = await decodeGroupEvent({ event: ev(JSON.stringify({ type: 'gkey_req' })), groupId: GROUP, store: storeHolding(new Map()) });
  assert.equal(isGroupControlBody(out.parsed), true);
});

test('a stored group row holding a control body is recognized, a real message is not', () => {
  assert.equal(isGroupControlRow({ isGroup: true, rawContent: JSON.stringify({ type: 'gkey_req' }) }), true);
  assert.equal(isGroupControlRow({ isGroup: true, rawContent: JSON.stringify({ type: 'typing' }) }), true);
  assert.equal(isGroupControlRow({ isGroup: true, rawContent: JSON.stringify({ type: 'text', message: 'hi' }) }), false);
  assert.equal(isGroupControlRow({ isGroup: true, rawContent: JSON.stringify({ type: 'system', message: 'a joined' }) }), false);
  assert.equal(isGroupControlRow({ isGroup: true, rawContent: null, ciphertext: '{"v":1}' }), false);
  assert.equal(isGroupControlRow({ isGroup: true, rawContent: 'not json' }), false);
  assert.equal(isGroupControlRow({ isGroup: false, data: { type: 'gkey_req' } }), false);
  assert.equal(isGroupControlRow(null), false);
});
