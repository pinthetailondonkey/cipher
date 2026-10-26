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
