import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip44, nip59 } from 'nostr-tools';
import {
  GIFT_WRAP_KIND,
  SEAL_KIND,
  rumorTags,
  sealAndWrap,
  withBuzzLabel,
  wrapForGateway,
} from './giftWrap.js';
import { isGiftWrap, isSeal, unwrapToRumor, labelFromPayload } from './giftUnwrap.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

function buildPair() {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  return {
    senderSk,
    recipientSk,
    senderPk: getPublicKey(senderSk),
    recipientPk: getPublicKey(recipientSk),
  };
}

// A fake send path exactly like useNIP44DM.sendDM builds it: NIP-44 with the
// conversation key of the two parties, the tags a thread reads, then seal+wrap.
function encryptFor(shared, payload) {
  return nip44.v2.encrypt(JSON.stringify(payload), shared);
}
function sharedKeyOf(sk, peerPk) {
  // conversationKey uses X-only derive both ways; nip44's own utility matches.
  return nip44.v2.utils.getConversationKey(sk, peerPk);
}

test('a wrapped DM hides the sender and carries no t-tag on the outer event', () => {
  const { senderSk, senderPk, recipientSk, recipientPk } = buildPair();
  const payload = { type: 'text', message: 'hello' };
  const stamped = withBuzzLabel(payload);
  const encrypted = encryptFor(sharedKeyOf(senderSk, recipientPk), stamped);
  const rumor = nip59.createRumor({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags({ recipient: recipientPk }),
    content: encrypted,
  }, senderSk);
  const { seal, wrap } = sealAndWrap(rumor, { senderSk, recipientPubkey: recipientPk });
  assert.equal(wrap.kind, GIFT_WRAP_KIND);
  assert.equal(seal.kind, SEAL_KIND);
  // The outer event that hits the relay names no sender: the wrap key is random.
  assert.notEqual(wrap.pubkey, senderPk);
  // No t tag in any plaintext field of the wire events. The wrap may not carry
  // one at all; the label lives inside the sealed layer now.
  for (const event of [wrap, seal]) {
    if (Array.isArray(event.tags)) {
      assert.equal(event.tags.some((tag) => tag[0] === 't'), false, 'a public t tag leaked');
    }
  }
});

test('a typing signal travels as a wrap and keeps its own clock', () => {
  // Typing used to be a bare kind-4 signed by the sender, so the one signal
  // that fires on every keystroke put the sender's key on the relay while every
  // real message stayed anonymous. It now shares the send path, and the two
  // traps that makes are pinned here: the outer event must be sender-less with
  // no t tag, and the freshness window the receiver applies must read the
  // rumor's clock, never the wrap's backdated one.
  const { senderSk, senderPk, recipientSk, recipientPk } = buildPair();
  const now = Math.floor(Date.now() / 1000);
  const encrypted = encryptFor(sharedKeyOf(senderSk, recipientPk), { type: 'typing' });
  const rumor = nip59.createRumor({
    kind: 4,
    created_at: now,
    tags: rumorTags({ recipient: recipientPk }),
    content: encrypted,
  }, senderSk);
  const { wrap } = sealAndWrap(rumor, { senderSk, recipientPubkey: recipientPk });

  assert.equal(wrap.kind, GIFT_WRAP_KIND);
  assert.notEqual(wrap.pubkey, senderPk, 'the sender is back on the wire');
  assert.deepEqual(wrap.tags.map((tag) => tag[0]), ['p'], 'the outer event must carry the p tag alone');

  // The wrap's created_at is backdated up to two days, so a ten-second freshness
  // check against it would drop every typing tick. The rumor's is the real one.
  assert.ok(wrap.created_at <= now, 'the wrap clock is not backdated');
  const opened = unwrapToRumor(wrap, recipientSk);
  assert.ok(opened, 'the peer cannot open a wrapped typing tick');
  assert.equal(opened.rumor.created_at, now, 'the freshness window would read a backdated clock');
  assert.equal(opened.rumor.pubkey, senderPk, 'the sender is not recoverable from the seal');
  assert.equal(nip44.v2.decrypt(opened.rumor.content, sharedKeyOf(recipientSk, senderPk)), '{"type":"typing"}');
});

test('the inner seal keeps what the relay must not see', () => {
  const { senderSk, senderPk, recipientSk, recipientPk } = buildPair();
  const stamped = withBuzzLabel({ type: 'order_request' });
  const sealed = sealAndWrap(nip59.createRumor({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags({ recipient: recipientPk, clientId: 'c1', replyId: 'r9' }),
    content: encryptFor(sharedKeyOf(senderSk, recipientPk), stamped),
  }, senderSk), { senderSk, recipientPubkey: recipientPk });
  const opened = unwrapToRumor(sealed.wrap, recipientSk);
  assert.ok(opened, 'the recipient opens the wrap');
  // The rumor is signed by the real sender inside, only opened by their key.
  assert.equal(opened.rumor.pubkey, senderPk);
  assert.deepEqual(
    opened.rumor.tags.filter(([k]) => k === 'p' || k === 'client' || k === 'e').map((t) => t[0]),
    ['p', 'client', 'e'],
  );
  const decoded = JSON.parse(nip44.v2.decrypt(opened.rumor.content, sharedKeyOf(recipientSk, senderPk)));
  assert.equal(decoded.t, 'order');
  assert.equal(decoded.type, 'order_request');
  assert.equal(labelFromPayload(decoded), 'order');
});

test('a stranger cannot open the wrap, and garbage never throws', () => {
  const { senderSk, recipientSk, recipientPk } = buildPair();
  const strangerSk = generateSecretKey();
  const { wrap } = sealAndWrap(nip59.createRumor({
    kind: 4,
    created_at: 1,
    tags: [['p', recipientPk]],
    content: 'x',
  }, senderSk), { senderSk, recipientPubkey: recipientPk });
  assert.equal(unwrapToRumor(wrap, strangerSk), null);
  assert.equal(unwrapToRumor(null, recipientSk), null);
  assert.equal(unwrapToRumor({}, recipientSk), null);
  assert.equal(unwrapToRumor({ kind: 4 }, recipientSk), null);
  assert.equal(isGiftWrap({ kind: 1059 }), true);
  assert.equal(isSeal({ kind: 13 }), true);
});

test('withBuzzLabel leaves silent payloads untouched and stamps buzzable ones once', () => {
  const typing = { type: 'typing' };
  assert.equal(withBuzzLabel(typing), typing);
  const read = { type: 'read', at: 3 };
  assert.equal(withBuzzLabel(read), read);
  const gkey = { t: 'gkey' };
  assert.equal(withBuzzLabel(gkey), gkey);
  const plain = { type: 'text', message: 'hi' };
  const stamped = withBuzzLabel(plain);
  assert.notEqual(stamped, plain);
  assert.equal(stamped.t, 'msg');
  assert.equal(withBuzzLabel(stamped), stamped, 'stamping twice does not churn the object');
  assert.deepEqual(withBuzzLabel({ type: 'call', state: 'ringing' }).t, 'call');
});

test('legacy bare kind-4 still opens on the same receiver path shapes', () => {
  // The transition promise: nothing about a legacy event changed shape. This
  // pins the decoder refusing to touch it, so hook branches keep reading
  // kind-4 envelopes exactly as before.
  const legacy = { kind: 4, content: 'enc', tags: [['p', 'aa']], pubkey: 'bb'.repeat(32), created_at: 1, id: 'i' };
  assert.equal(unwrapToRumor(legacy, generateSecretKey()), null, 'a bare kind-4 is not a wrap and needs no unwrap');
  assert.equal(isGiftWrap(legacy), false);
});

test('a wrapped notice for the gateway reads recipient and label without touching the body', () => {
  const { senderSk, recipientPk } = buildPair();
  const gatewaySk = generateSecretKey();
  const gatewayPk = getPublicKey(gatewaySk);
  const wrap = wrapForGateway({
    senderSk,
    recipientPubkey: recipientPk,
    gatewayPubkey: gatewayPk,
    payload: { type: 'text' },
  });
  assert.ok(wrap, 'a buzzable DM wraps a copy for the gateway');
  const opened = unwrapToRumor(wrap, gatewaySk);
  assert.ok(opened, 'the gateway opens its own layer');
  assert.equal(opened.rumor.pubkey, getPublicKey(senderSk), 'seal signed by the sender');
  const who = opened.rumor.tags.find((tag) => tag[0] === 'p')?.[1];
  assert.equal(who, recipientPk);
  const kind = opened.rumor.tags.find((tag) => tag[0] === 't')?.[1];
  assert.equal(kind, 'msg');
  assert.equal(opened.rumor.content, '', 'the gateway layer carries no message body');

  // Silent signals wrap nothing: the box hears only what used to have a t tag.
  for (const silent of [{ type: 'typing' }, { type: 'read' }, { t: 'gkey' }, { type: 'pin' }]) {
    assert.equal(wrapForGateway({ senderSk, recipientPubkey: recipientPk, gatewayPubkey: gatewayPk, payload: silent }), null);
  }
});
