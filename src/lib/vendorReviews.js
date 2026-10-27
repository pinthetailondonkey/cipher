// Vendor reviews, read against the trade they came from.
//
// A review exists only where the deal itself is provable: the device that
// countersigned the deal's receipt. proofOfTrade already writes two scoped
// records when a receipt binds — `receipt_<orderId>` (the two-signed
// receipt) and `bound_receipt_<orderId>` (the hash this device signed
// after the binding passed). This library reads those records and never
// rewrites their rules: eligibility, display and the shop counters all
// re-derive from the receipt this device holds, so a review is never a
// claim a stranger could invent — and never a per-order number a shop
// could publish. Reviews themselves stay local to the reviewer's account
// database (db.js, the vendorReviews table); nothing here sends.
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

// The one number a menu shows: how many of this vendor's deals this device
// can prove on chain — distinct bound receipt hashes that a signed public
// view (buyer and vendor, or the vendor's own signature) names.
export function dealsProvenForVendor(vendorPubkey) {
  const vendor = lower(vendorPubkey);
  if (!vendor) return 0;
  const views = readPublicViews();
  const proven = new Set();
  for (const { receipt, hash } of boundReceipts()) {
    if (lower(receipt.body.vendor) !== vendor) continue;
    const view = views.find((row) => row?.hash === hash);
    if (!view) continue;
    try {
      if (!verifyPublicView(view) && !verifyVendorView(view)) continue;
    } catch {
      continue;
    }
    proven.add(hash);
  }
  return proven.size;
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
    dealsProven: dealsProvenForVendor(vendorPubkey),
    monthsActive: monthsActiveForVendor(vendorPubkey),
  };
}

