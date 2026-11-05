// NIP-59 gift wrap helpers shared by the DM hook and the push gateway.
//
// Today a DM is a bare kind-4 event signed by the sender. The t=msg|order|call
// tag the push gateway needs sits on that public event in plain text, so the
// relay learns whether each exchange is a message, an order, or a call. The
// label now travels inside the sealed payload and the outer event is a
// kind-1059 wrap signed by a random key: no sender, no t-tag to read.
//
// Seals and wraps here use nostr-tools' nip59 directly. The seal is built
// around a rumor whose tags keep the p/e/client tags the thread expects, and
// the buzz label moves into the sealed payload as `t`, so the receiver reads
// it back at unwrap before anything is dispatched.
//
// The outer wrap is the one event built by hand, and only because it has to
// carry a second tag: an `expiration` (see WRAP_TTL_SECONDS) that asks the relay
// to drop the only server-side copy of a message. nip59.createWrap hardcodes
// ['p', recipient], so this file reimplements its four lines around the same
// nip44 encryption.

import { nip44, nip59 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { buzzTagFor } from './pushGateway.js';

export const GIFT_WRAP_KIND = 1059;
export const SEAL_KIND = 13;

// How long a relay may keep the only server-side copy of a message. Long
// enough that a month away from the app still recovers history: the live
// subscription only asks for the last 7 days, but the history fetch has no
// lower bound, so this is the real horizon. Short enough that the relay is
// not the permanent archive an address book is.
export const WRAP_TTL_SECONDS = 30 * 24 * 60 * 60;

// nostr-tools backdates a wrap by up to two days so the send time cannot be
// read off the wire. Mirrored here because createWrap takes no extra tags and
// the expiration has to sit inside the signed event. It is measured from that
// backdated clock on purpose: a `now()`-based stamp would hand the relay back
// the exact true second the backdate was hiding.
const TWO_DAYS = 2 * 24 * 60 * 60;
const randomNow = () => Math.round(Date.now() / 1000 - Math.random() * TWO_DAYS);

// The outer wrap a relay sees: one p tag and one expiration, never a sender.
// Built by hand (rather than via nip59.createWrap) only to carry that second
// tag; the encryption is nip59's own.
function buildWrap(seal, recipientPubkey, createdAt = randomNow()) {
  const randomKey = generateSecretKey();
  return finalizeEvent({
    kind: GIFT_WRAP_KIND,
    created_at: createdAt,
    tags: [
      ['p', recipientPubkey],
      ['expiration', String(createdAt + WRAP_TTL_SECONDS)],
    ],
    content: nip44.v2.encrypt(
      JSON.stringify(seal),
      nip44.v2.utils.getConversationKey(randomKey, recipientPubkey),
    ),
  }, randomKey);
}

// The rumor carries the tags a chat thread reads on a bare kind-4: the p tag
// naming the recipient, the client id and the reply marker. The sender's
// identity is inside the seal, not on the wrap.
export function rumorTags({ recipient, clientId = null, replyId = null, extra = [] }) {
  return [
    ['p', recipient],
    ...(clientId ? [['client', clientId]] : []),
    ...(replyId ? [['e', replyId, '', 'reply']] : []),
    ...extra,
  ];
}

// Wraps a rumor-shaped event for one recipient. Returns the signed kind-1059
// wrap (outer, anonymous sender) and the kind-13 seal (inner, signed by the
// sender) so a caller can prove what it hid. The rumor must carry its own id
// and pubkey, exactly as nip59.createRumor leaves them, so the seal can bind
// to this exact content.
export function sealAndWrap(rumor, { senderSk, recipientPubkey } = {}) {
  if (!rumor?.pubkey || !rumor?.id) throw new Error('A rumor needs its pubkey and id before sealing.');
  const seal = nip59.createSeal(rumor, senderSk, recipientPubkey);
  const wrap = buildWrap(seal, recipientPubkey);
  return { seal, wrap };
}

// Where the push label rides now: the sealed payload's `t` field. Null for
// silent signals such as typing, read marks, pins and key bundles.
export function buzzLabelFor(payload) {
  return buzzTagFor(payload);
}

// Stamps a copy of the payload with the buzz label. The original object is
// never mutated; the encrypted body carries this label and every store
// dispatch that reads it later also sees it, so no caller changes.
export function withBuzzLabel(payload) {
  const label = buzzTagFor(payload);
  if (!label || !payload || typeof payload !== 'object') return payload;
  if (payload.t === label) return payload;
  return { ...payload, t: label };
}

// Wraps a copy of an already-sealed DM for the push gateway's ephemeral key.
// The gateway opens its own layer; what it finds is a rumor whose content
// names only the recipient and the buzz label, so nothing but "something of
// this kind arrived for this key" ever leaves the seal.
// Returns null when there is nothing worth waking a phone for (typing, read
// marks, pins, key bundles) so no wrap is published at all.
export function wrapForGateway({ senderSk, recipientPubkey, gatewayPubkey, payload }) {
  const label = buzzLabelFor(payload);
  if (!label || !senderSk || !recipientPubkey || !gatewayPubkey) return null;
  // The t tag is in the rumor from the start so the id binds to the final
  // content: a seal of a stale hash would fail unwrap verification.
  const notice = nip59.createRumor({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey], ['t', label]],
    content: '',
  }, senderSk);
  // The gateway cannot open the sender-recipient NIP-44 body, and must not:
  // its layer carries the classification alone, one tag deep inside a wrap
  // addressed to an ephemeral key no relay attribute ties to anyone.
  const seal = nip59.createSeal(notice, senderSk, gatewayPubkey);
  return buildWrap(seal, gatewayPubkey);
}
