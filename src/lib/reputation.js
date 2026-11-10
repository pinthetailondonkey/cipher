// A vouch or a review is a claim about a completed trade. These are the two
// decisions every reader of one applies before it counts: the event must name
// the receipt hash of a real trade, and a rating can only pull an average
// toward zero, never below it. (security S8)

const HEX64 = /^[0-9a-f]{64}$/;

// The receipt-hash tag on a vouch or review event. The hash is all that is
// published — no amount, no order, no payment details; the receipt itself
// stays private between the two parties. Without a well-formed hash the event
// is an invented vouch and counts for nothing.
export function receiptBindingOf(event) {
  const row = (event?.tags || []).find((tag) => tag[0] === 'receipt');
  const hash = String(row?.[1] || '').toLowerCase();
  return HEX64.test(hash) ? hash : '';
}

// The trade a vouch names, beyond the hash: the vendor and buyer of the
// completed trade it points at, both published under the author's own
// signature. The hash alone cannot be checked by a reader — the receipt is
// private — so the role tags are what keep a vouch from being transplanted
// onto a trade it does not belong to. (security S8)
export function vouchTradeOf(event) {
  const tag = (name) => String((event?.tags || []).find((row) => row[0] === name)?.[1] || '').toLowerCase();
  const vendor = tag('trade_vendor');
  const buyer = tag('trade_buyer');
  return vendor && buyer && vendor !== buyer ? { vendor, buyer } : null;
}

// A vouch counts toward a target only when the named trade involves both the
// target and the author. Anything else is one real receipt vouching for a
// stranger: the part the hash-check could not see reader-side.
export function vouchCoversTrade(event, targetPubkey) {
  const trade = vouchTradeOf(event);
  if (!trade) return false;
  const author = String(event?.pubkey || '').toLowerCase();
  const target = String(targetPubkey || '').toLowerCase();
  return (target === trade.vendor || target === trade.buyer)
    && (author === trade.vendor || author === trade.buyer)
    && author !== target;
}

// Public vouches are endorsements only. No wire tag can establish a receipt's
// signatures or independent settlement provenance, so this projection never
// promotes a self-reported hash into verified trade evidence.
export function tradeEvidenceOf(event) {
  const hash = receiptBindingOf(event);
  const trade = vouchTradeOf(event);
  if (!hash || !trade) return { state: 'unverified-endorsement', receiptHash: hash || null };
  return { state: 'unverified-endorsement', receiptHash: hash, parties: trade };
}

// A rating outside 0..5 is a numbers game, not an opinion. Anything
// unparseable is a zero, anything negative is a zero, anything above 5 is a 5.
export function clampRating(value) {
  const rating = Number.parseInt(value, 10);
  if (!Number.isFinite(rating)) return 0;
  return Math.min(5, Math.max(0, rating));
}

// The average of clamped ratings, clamped itself at zero. A buyer who leaves
// a negative score pulls the average down toward 0 and no further, so a pile
// of attack reviews cannot spell a vendor below zero.
export function averageRating(values) {
  const rows = (Array.isArray(values) ? values : []).map(clampRating);
  if (!rows.length) return '0.0';
  const sum = rows.reduce((acc, value) => acc + value, 0);
  return Math.max(0, sum / rows.length).toFixed(1);
}

// The age a profile event's `created_at` appears to claim, in whole days, and
// nothing stronger. A kind-0 timestamp is written by its publisher: it is when
// that copy of the profile was last edited, not when the key or the account
// came into being, and nothing signs it but its own author. A missing or
// future stamp reads as zero — a future timestamp must not read as an old
// account. The count no longer gates on this value (see useReputation), so
// these are the honest numbers for a label, not a trust signal.
export function profileAgeDays(createdAt, nowSec) {
  const created = Number(createdAt);
  const now = Number(nowSec);
  if (!Number.isFinite(created) || created <= 0 || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - created) / 86400));
}
