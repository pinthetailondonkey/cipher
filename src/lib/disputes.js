// The dispute thread of a review: three one-shot riders, nothing deleted.
//
// Founder rulings (vendor shops, 2026-10-27): a buyer's review can be
// disputed with no admin — the vendor gets one FLAG and one REBUTTAL, the
// buyer gets one SUPPLEMENT. Each rider word exists at most once per
// (receipt, review) pair. Nothing is ever deleted: a rider that arrived
// stands, a later duplicate of the same rider word simply does not render
// as the rider of record, and a review with no dispute renders untouched.
//
// The event (kind 10006) is bound per pair like everything receipt-bound:
//   tags:  p (the vendor whose review thread this runs under),
//          receipt (the same 64-hex binding the review names),
//          review (the id of the review event it rides on),
//          rider (one of the three words).
// content is the rider's plain statement. No item, no amount, no buyer
// identity — nothing about the order belongs on this wire.
//
// Authorship a reader can check on the wire: a vendor-flag and a
// vendor-rebuttal must be signed by the vendor they run under, and a
// buyer-supplement cannot be signed by the vendor (a vendor co-signing a
// fake buyer is self-contradictory on its face). Beyond that a supplement
// is a signed claim like the review itself — the receipt is private and
// buyer identity is never published, so the party holding the receipt is
// the one who can call it false.

import { receiptBindingOf } from './reputation.js';

export const DISPUTE_KIND = 10006;
export const RIDER_WORDS = ['vendor-flag', 'vendor-rebuttal', 'buyer-supplement'];

const HEX64 = /^[0-9a-f]{64}$/;

const tagValue = (event, name) =>
  String(event?.tags?.find((row) => row[0] === name)?.[1] || '').toLowerCase().trim();

// Three one-shot riders per (receipt, review). The pick is deterministic
// when duplicates arrive: the earliest one landed wins, and same-second
// arrivals break the tie on the event id. A duplicate is never consumed —
// it stays published, it just never renders as the rider of record.
export function parseDispute(event) {
  if (!event || event.kind !== DISPUTE_KIND) return null;
  const rider = tagValue(event, 'rider');
  if (!RIDER_WORDS.includes(rider)) return null;
  const receipt = receiptBindingOf(event);
  if (!receipt) return null;
  const review = tagValue(event, 'review');
  if (!HEX64.test(review)) return null;
  const vendor = tagValue(event, 'p');
  const author = String(event.pubkey || '').toLowerCase();
  if (!HEX64.test(vendor) || !HEX64.test(author)) return null;
  const text = String(event.content || '').trim();
  if (!text) return null;
  return { rider, vendor, receipt, review, text, author, created_at: Number(event.created_at) || 0 };
}

// The one derivation the compose screen and the review screen both read.
// `bindings` = { vendor, receipt, review }; events = a fetched dispute set
// (kinds other than 10006 are ignored). Returns every rider word as a key,
// parsed rider of record or null — presence of a parsed rider is also the
// one-shot signal: the word is taken, no second flag, no second rebuttal,
// no second supplement.
export function ridersForReview(bindings, events) {
  const vendor = String(bindings?.vendor || '').toLowerCase();
  const receipt = String(bindings?.receipt || '').toLowerCase();
  const review = String(bindings?.review || '').toLowerCase();
  const out = {};
  for (const word of RIDER_WORDS) out[word] = null;
  if (!vendor || !HEX64.test(receipt) || !HEX64.test(review)) return out;
  for (const event of events || []) {
    const parsed = parseDispute(event);
    if (!parsed || parsed.vendor !== vendor || parsed.receipt !== receipt || parsed.review !== review) continue;
    if (parsed.rider === 'vendor-flag' || parsed.rider === 'vendor-rebuttal') {
      // A vendor rider signed by anyone else is not the vendor's word.
      if (parsed.author !== vendor) continue;
    } else if (parsed.rider === 'buyer-supplement') {
      if (parsed.author === vendor) continue;
    }
    const held = out[parsed.rider];
    const earlier = !held
      || parsed.created_at < held.created_at
      || (parsed.created_at === held.created_at && String(event.id || '') < String(held.id || ''));
    if (earlier) out[parsed.rider] = { ...parsed, id: String(event.id || '') };
  }
  return out;
}
