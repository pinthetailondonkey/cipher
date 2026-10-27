// Vendor reviews, read against the trade they came from.
//
// A review exists only where the deal itself is provable: the device that
// countersigned the deal's receipt. proofOfTrade already writes two scoped
// records when a receipt binds — `receipt_<orderId>` (the two-signed
// receipt) and `bound_receipt_<orderId>` (the hash this device signed
// after the binding passed). This library reads those records and never
// rewrites their rules: eligibility, display and the menu counters all
// re-derive from the receipt this device holds, so a review is never a
// claim a stranger could invent — and never a per-order number a menu
// could publish. Reviews themselves stay local to the reviewer's account
// database (db.js, the vendorReviews table); nothing here sends.
//
// This file is strictly screen-side. The vendor data layer — review
// events, the txid bulletin, dispute records — is owned by the Deal lane
// on main. Nothing here names kinds on the wire, publishes, or structures
// bulletin records; the display consumes those contracts by swapping the
// proven-count provider and the review reader in useVendorReviews, never
// by widening this file.
import { scopedGet, getActivePubkey } from './storage';
import {
  readPublicViews,
  verifyPublicView,
  verifyReceipt,
  verifyVendorView,
} from './proofOfTrade';
import { ORDER_STATUS } from './paymentState';
import { orderState } from './orderActions';

const HEX64 = /^[0-9a-f]{64}$/;

// The review publisher gate. Deal's kind-10005 ( review post) publisher
// does not exist on this branch — it ships on main. Until it folds:
//   - review rows render only from Deal's reader contract, so the vendor
//     profile's review list stays empty (its own "No reviews yet." state);
//   - a compose saves locally to this account's database and publishes
//     nothing.
// Flipping this true is the fold: the publisher below gains its real body
// in that same change.
export const REVIEW_WIRING_LANDED = false;

// Publisher swaps to Deal-lane kind-10005 publisher on fold. Nothing on
// this branch publishes a review; the stub refuses so no code path can
// send while the gate is down.
export function createReviewPublisher() {
  if (!REVIEW_WIRING_LANDED) return null;
  return null;
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function lower(value) {
  return String(value || '').toLowerCase();
}

// The order month a review shows: the year-month of the payment the receipt
// recorded, in UTC. Nothing else about the order — no item, no amount —
// ever reaches the review surface.
export function orderMonthOf(at) {
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// "Order from March 2025" — the only date wording a review row shows.
export function monthLabelOf(orderMonth) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(orderMonth || ''));
  if (!match) return '';
  const month = Number.parseInt(match[2], 10);
  if (month < 1 || month > 12) return '';
  return `Order from ${MONTH_NAMES[month - 1]} ${match[1]}`;
}

// Whole months a vendor has been taking proven deals: the month count
// between the earliest receipt and now, counting a month only once it is
// reached again (whole months, never inflated).
export function wholeMonthsBetween(earliestAt, nowAt) {
  const from = new Date(Number(earliestAt) * 1000);
  const to = new Date(Number(nowAt) * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

// The receipt records this device holds. Enumeration is scoped to the
// active account's own key prefix — a legacy drawer from a prefix-sibling
// account is another account's property and never reads here. A record
// counts only when the receipt still verifies AND this device's binding
// mark names it: the same gate the countersign wrote at binding time.
export function boundReceipts() {
  const active = getActivePubkey();
  if (!active || active === 'guest') return [];
  const prefix = `cipher_${active}_receipt_`;
  let storedKeys = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return [];
    storedKeys = Array.from({ length: storage.length || 0 }, (_, index) => storage.key(index)).filter(Boolean);
  } catch {
    return [];
  }
  const rows = [];
  for (const storedKey of storedKeys) {
    if (!storedKey.startsWith(prefix)) continue;
    const orderId = storedKey.slice(prefix.length);
    if (!orderId) continue;
    const receipt = scopedGet(`receipt_${orderId}`, null);
    const boundHash = scopedGet(`bound_receipt_${orderId}`, '');
    if (!receipt?.body || !boundHash || receipt.hash !== boundHash) continue;
    try {
      if (!verifyReceipt(receipt)) continue;
    } catch {
      continue;
    }
    rows.push({ orderId, receipt, hash: receipt.hash });
  }
  return rows;
}

// Proven deals, in the Deal data layer's shape (vendorStats on main): an
// object KEYED BY RAIL — { btc: { count, txids, phrasing: 'proven' }, xmr:
// { count, txids, phrasing: 'recorded' } } — one key per rail with proven
// deals, {} when nothing is proven. A rail key carries its banner phrasing
// with it; the display reads the keys it is given and never sums rails
// into one figure.
//
// Nothing vendor-reported can enter the count here: every entry comes from
// a bound receipt this device countersigned that a signed public view
// names — the data layer's vendor-reported kind is excluded at its source,
// not by convention in this file.
const KNOWN_RAILS = { btc: 'proven', xmr: 'recorded' };
const RAIL_ORDER = ['btc', 'xmr'];

function railRank(rail) {
  const at = RAIL_ORDER.indexOf(rail);
  return at === -1 ? RAIL_ORDER.length : at;
}

// The rail a receipt's currency names. The device-local receipt only
// certifies the two rails this app settles; any other currency word proves
// nothing here — fail closed, the rail must be recognized before it counts.
function railOf(currency) {
  const word = String(currency || '').trim().toLowerCase();
  if (/^btc/.test(word)) return 'btc';
  if (/^(xmr|monero)/.test(word)) return 'xmr';
  return '';
}

function provenMapsForVendor(vendorPubkey) {
  const vendor = lower(vendorPubkey);
  const proven = new Map();
  if (!vendor) return proven;
  const views = readPublicViews();
  for (const { receipt, hash } of boundReceipts()) {
    if (lower(receipt.body.vendor) !== vendor) continue;
    const rail = railOf(receipt.body.currency);
    if (!rail) continue;
    const view = views.find((row) => row?.hash === hash);
    if (!view) continue;
    try {
      if (!verifyPublicView(view) && !verifyVendorView(view)) continue;
    } catch {
      continue;
    }
    if (!proven.has(rail)) proven.set(rail, new Map());
    proven.get(rail).set(hash, String(receipt.body.txid || '').trim());
  }
  return proven;
}

// The proven-count seam, keyed by rail. 'proven' banners as "N deals
// proven. One tap shows the txids."; 'recorded' banners as "N deals
// recorded on chain." Provider swaps to the Deal lane's txid-bulletin
// contract (see DATA-LAYER owner on main) replace this fallback's body
// alone; no call site counts records itself.
//
// Fallback derivation, device-local: a proven deal is a bound receipt this
// device countersigned that a signed public view names. The fallback's
// count is those distinct receipts, not a bulletin length — the bulletin
// count-is-txids rule is the data layer's, and it owns the real source.
// The txids ride along (the receipts carry them) so the tap-through has
// data when the banner learns to open it. Rails without proven deals stay
// absent keys, so the shape is exactly the data layer's.
export function provenDealsForVendor(vendorPubkey) {
  const keyed = {};
  for (const [rail, hashes] of provenMapsForVendor(vendorPubkey)) {
    keyed[rail] = {
      count: hashes.size,
      rail,
      txids: [...new Set([...hashes.values()].filter(Boolean))],
      phrasing: KNOWN_RAILS[rail],
    };
  }
  return keyed;
}

export const dealsProvenOf = provenDealsForVendor;

// The total across rails. The display never blends rails into one figure —
// Bitcoin's count proves itself, Monero's only proves existence, and a sum
// would say less than either rail's own words — this total stays for the
// plain "how many" callers that do not banner it.
export function dealsProvenForVendor(vendorPubkey) {
  let total = 0;
  for (const entry of Object.values(provenDealsForVendor(vendorPubkey))) {
    total += Number(entry?.count) || 0;
  }
  return total;
}

// One rail's banner words, verbatim from the contract. A rail the renderer
// does not know gets no invented wording: a neutral pass-through that
// names the rail and counts, with no claim attached (the conductor still
// rules on that copy — see the lane report). Empty when the count is
// nothing or nothing can be said.
export function provenBannerOf(entry) {
  const count = Math.max(0, Math.floor(Number(entry?.count) || 0));
  if (!count || !entry) return '';
  const phrasing = String(entry.phrasing || '');
  if (phrasing === 'recorded') return `${count} ${count === 1 ? 'deal' : 'deals'} recorded on chain.`;
  if (phrasing === 'proven') return `${count} ${count === 1 ? 'deal' : 'deals'} proven. One tap shows the txids.`;
  if (String(entry.rail || '')) return `${count} ${count === 1 ? 'deal' : 'deals'} · ${entry.rail}`;
  return '';
}

// The stats band's lines: one per rail the contract object carries, btc
// first, xmr second, then any further rail in the order the object hands
// over (Deal publishes per-asset config; nothing here assumes exactly two
// rails, and no line ever sums two rails together).
export function provenLinesOf(proven) {
  if (Array.isArray(proven)) {
    return proven.map(provenBannerOf).filter(Boolean);
  }
  if (!proven || typeof proven !== 'object') return [];
  const keys = Object.keys(proven).sort((a, b) => railRank(a) - railRank(b));
  return keys
    .map((rail) => {
      const value = proven[rail];
      if (value && typeof value === 'object') return { ...value, rail };
      const count = Number(value) || 0;
      return { count, rail, phrasing: KNOWN_RAILS[rail] || '' };
    })
    .map(provenBannerOf)
    .filter(Boolean);
}

// Months active: whole months since this vendor's earliest bound receipt
// on this device. Zero deals means zero months — nothing to say yet.
export function monthsActiveForVendor(vendorPubkey, nowAt = Math.floor(Date.now() / 1000)) {
  const vendor = lower(vendorPubkey);
  if (!vendor) return 0;
  let earliest = null;
  for (const { receipt } of boundReceipts()) {
    if (lower(receipt.body.vendor) !== vendor) continue;
    const at = Number(receipt.body.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (earliest == null || at < earliest) earliest = at;
  }
  if (earliest == null) return 0;
  return wholeMonthsBetween(earliest, nowAt);
}

// Pure eligibility gate. Every fact arrives as a parameter; the callers
// that read storage compose them. A review may be composed when:
//   - the receipt is the two-signed artifact and still verifies,
//   - this device's binding mark names that receipt (the buyer of a bound
//     receipt — the mark only exists where the binding passed),
//   - the reviewer is the receipt's buyer, not the vendor, and the vendor
//     is the receipt's vendor,
//   - the deal reached completed (the sealed state the order ledger reads).
export function reviewEligibility(facts = {}) {
  const { receipt, boundHash, buyerPubkey, vendorPubkey, status } = facts || {};
  if (!receipt?.body || !boundHash) return false;
  if (receipt.hash !== boundHash) return false;
  try {
    if (!verifyReceipt(receipt)) return false;
  } catch {
    return false;
  }
  if (lower(receipt.body.buyer) !== lower(buyerPubkey) || !buyerPubkey) return false;
  if (vendorPubkey && lower(receipt.body.vendor) !== lower(vendorPubkey)) return false;
  return status === ORDER_STATUS.COMPLETED;
}

// The offer behind the "Review this deal" button: the bound receipt of
// THIS order, completed on this device, with the buyer's key on it. Null
// when any part is missing — the button simply never renders.
export function reviewOfferForOrder({ messages, order, buyerPubkey, vendorPubkey } = {}) {
  if (!order?.id || !buyerPubkey || !vendorPubkey) return null;
  const receipt = scopedGet(`receipt_${order.id}`, null);
  const boundHash = scopedGet(`bound_receipt_${order.id}`, '');
  let status = '';
  try {
    status = orderState(Array.isArray(messages) ? messages : [], order.id, order, buyerPubkey, vendorPubkey).status;
  } catch {
    return null;
  }
  if (!reviewEligibility({ receipt, boundHash, buyerPubkey, vendorPubkey, status })) return null;
  return {
    orderId: String(order.id),
    receipt,
    buyerPubkey: lower(buyerPubkey),
    vendorPubkey: lower(receipt.body.vendor),
    orderMonth: orderMonthOf(receipt.body.at),
  };
}

// A stored review, normalized. The seven fields the surface shows, plus the
// two the display check needs to re-derive itself: orderId (to find the
// binding mark) and the signed receipt (so display never trusts the row).
export function normalizeReview(input = {}) {
  const vendorPubkey = lower(input.vendorPubkey);
  const buyerPubkey = lower(input.buyerPubkey);
  const receiptHash = lower(input.receiptHash);
  if (!HEX64.test(receiptHash)) throw new Error('A review binds the receipt hash of the deal.');
  if (!vendorPubkey || !buyerPubkey || vendorPubkey === buyerPubkey) throw new Error('A review names its vendor and its buyer.');
  const stars = Number.parseInt(input.stars, 10);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('A review is one to five stars.');
  const verdict = String(input.verdict || '').trim();
  if (!verdict) throw new Error('A review needs a one-line verdict.');
  if (verdict.length > 140) throw new Error('A verdict is one line.');
  const createdAt = Number.parseInt(input.createdAt, 10) > 0 ? Number.parseInt(input.createdAt, 10) : Math.floor(Date.now() / 1000);
  const orderId = String(input.orderId || '').trim();
  if (!orderId) throw new Error('A review names the order it came from.');
  const receipt = input.receipt;
  if (!receipt?.body || receipt.hash !== receiptHash) throw new Error('A review keeps the receipt it came from.');
  try {
    if (!verifyReceipt(receipt)) throw new Error('A review keeps a receipt that verifies.');
  } catch (error) {
    throw new Error(error?.message || 'A review keeps a receipt that verifies.');
  }
  const orderMonth = /^\d{4}-\d{2}$/.test(String(input.orderMonth || '')) ? String(input.orderMonth) : orderMonthOf(receipt.body.at);
  return {
    vendorPubkey,
    buyerPubkey,
    stars,
    verdict,
    orderMonth,
    receiptHash,
    createdAt,
    orderId,
    receipt,
  };
}

// Display rule, fail closed. A stored review shows only when its receipt
// still verifies, still carries this device's binding mark, and reads
// confirmed on chain (the outcome the watcher-side signature asserted).
// Anything else — a tampered row, a mark gone, an unconfirmed outcome —
// never renders.
export function canDisplayReview(row) {
  try {
    const receipt = row?.receipt;
    if (!receipt?.body || receipt.hash !== row.receiptHash) return false;
    if (!verifyReceipt(receipt)) return false;
    if (String(receipt.body.outcome || '') !== 'confirmed') return false;
    const orderId = String(row.orderId || '').trim();
    if (!orderId) return false;
    if (String(scopedGet(`bound_receipt_${orderId}`, '')) !== row.receiptHash) return false;
    if (lower(receipt.body.vendor) !== lower(row.vendorPubkey)) return false;
    if (lower(receipt.body.buyer) !== lower(row.buyerPubkey)) return false;
    return true;
  } catch {
    return false;
  }
}

// One review per deal: the bound receipt hash is the primary key, so a
// second save for the same trade replaces the first.
export async function saveReview(review, table) {
  const rows = table || (await import('../db')).db.vendorReviews;
  const row = normalizeReview(review);
  await rows.put(row);
  return row;
}

export async function getReviewForReceipt(receiptHash, table) {
  const hash = lower(receiptHash);
  if (!hash) return null;
  const rows = table || (await import('../db')).db.vendorReviews;
  const row = await rows.get(hash);
  return row || null;
}

// The reviews a vendor's identity page shows: every stored review for the
// vendor that still passes the display rule, newest first.
export async function reviewsForVendor(vendorPubkey, table) {
  const vendor = lower(vendorPubkey);
  if (!vendor) return [];
  const rows = table || (await import('../db')).db.vendorReviews;
  const stored = await rows.where('vendorPubkey').equals(vendor).toArray();
  return stored.filter(canDisplayReview).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// The summary band: count and average on the displayed rows. The average
// floor rule is reputation's own (a pile of attack reviews pulls toward
// zero, never below).
export function reviewSummaryOf(rows, averageOf) {
  const list = Array.isArray(rows) ? rows : [];
  const average = averageOf
    ? averageOf(list.map((row) => row.stars))
    : (list.length ? (list.reduce((sum, row) => sum + (Number(row.stars) || 0), 0) / list.length).toFixed(1) : '0.0');
  return { count: list.length, average };
}

// The standing numbers one vendor page shows, read once per mount.
export function vendorStandingOf(vendorPubkey) {
  return {
    proven: provenDealsForVendor(vendorPubkey),
    dealsProven: dealsProvenForVendor(vendorPubkey),
    monthsActive: monthsActiveForVendor(vendorPubkey),
  };
}

