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
import { scopedGet, scopedSet } from './storage.js';

export const DISPUTE_KIND = 10006;
export const RIDER_WORDS = ['vendor-flag', 'vendor-rebuttal', 'buyer-supplement'];

const HEX64 = /^[0-9a-f]{64}$/;
const OWN_RIDERS_KEY = 'dispute_riders_own';

const tagValue = (event, name) =>
  String(event?.tags?.find((row) => row[0] === name)?.[1] || '').toLowerCase().trim();

// The pair a rider lives on, spelled one way everywhere a key is needed.
export function riderPairKey(vendor, receipt, review) {
  return [vendor, receipt, review].map((part) => String(part || '').toLowerCase().trim()).join(':');
}

// This device's own posted riders, in scoped storage, not memory — the
// compose guard must survive a reload, and a refetch can come back partial,
// so a second rider is refused by a record this device wrote the first time
// it signed one. A relay copy can always be fetched again; the record of a
// word this device already spent cannot be un-spent.
export function ownRiderTaken(vendor, receipt, review, rider) {
  if (!RIDER_WORDS.includes(rider)) return false;
  const ledger = scopedGet(OWN_RIDERS_KEY, {}) || {};
  const entry = ledger[riderPairKey(vendor, receipt, review)];
  return !!(entry && entry[rider]);
}

// Written once the rider is signed and on its way — a signed rider this
// device intends to send already spends the word, whatever a publish
// hiccup made of the moment. An unreadable or refused sign never reaches
// this mark.
export function markOwnRider(vendor, receipt, review, rider, eventId) {
  if (!RIDER_WORDS.includes(rider)) return false;
  const key = riderPairKey(vendor, receipt, review);
  if (!key || !String(eventId || '').trim()) return false;
  const ledger = scopedGet(OWN_RIDERS_KEY, {}) || {};
  const entry = ledger[key] || {};
  entry[rider] = String(eventId).trim();
  ledger[key] = entry;
  scopedSet(OWN_RIDERS_KEY, ledger);
  return true;
}

// The words a compose screen and the publisher both enforce before a
// rider leaves this device, in one place. One-shot lives beside it: a
// parseable pair this device has already ridden refuses the same word
// before anything is signed.
export function riderRefusal({ author, vendor, receiptHash, review, rider, text }) {
  const body = String(text || '').trim();
  if (!RIDER_WORDS.includes(rider)) return 'That is not a rider word this thread knows.';
  const binding = receiptBindingOf({ tags: [['receipt', receiptHash]] });
  if (!binding) return 'A rider needs the receipt of the completed trade the review names.';
  const vendorKey = String(vendor || '').toLowerCase();
  if (!HEX64.test(vendorKey)) return 'The vendor this thread runs under is not readable.';
  if (!HEX64.test(String(review || '').toLowerCase().trim())) return 'A rider is posted against a review — name the review event.';
  if (!body) return 'A rider says something, or it says nothing.';
  const authorKey = String(author || '').toLowerCase();
  if (rider === 'vendor-flag' || rider === 'vendor-rebuttal') {
    if (authorKey !== vendorKey) return 'Only the vendor flags or rebuts on their own thread.';
  } else if (authorKey === vendorKey) {
    return 'The vendor does not co-sign a buyer supplement.';
  }
  if (ownRiderTaken(vendorKey, binding, String(review).toLowerCase().trim(), rider)) return 'This device already spent its one word of that kind on this review.';
  return null;
}

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
