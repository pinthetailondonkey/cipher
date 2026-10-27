// Every status an order message can carry. The order actions write only
// these, and the order card reads only these.
export const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PAID: 'paid',
  SHIPPED: 'shipped',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  DISPUTED: 'disputed',
});
export const ORDER_STATUSES = Object.freeze(Object.values(ORDER_STATUS));
export const PAYMENT_STATES = Object.freeze(['created', 'address_issued', 'seen', 'confirmed']);
// What a vendor may assert when signing a receipt (docs/proof-of-trade.md).
export const RECEIPT_OUTCOME = Object.freeze({ CONFIRMED: 'confirmed', RUGGED: 'rugged', REFUNDED: 'refunded' });
export const RECEIPT_OUTCOMES = Object.freeze(Object.values(RECEIPT_OUTCOME));

export function isOrderStatus(status) {
  return ORDER_STATUSES.includes(status);
}

// The payment states stay a straight walk: created, address_issued, seen,
// confirmed. Nothing skips, and nothing about a dispute lives here (security
// S6) — a refund is a new transaction a watcher reports for itself, and the
// dispute's life is the order's status layer, not this table.
const NEXT = {
  created: { issue: 'address_issued' },
  address_issued: { see: 'seen' },
  seen: { confirm: 'confirmed' },
};

// The one table that knows a coin. Founder ruling ("deal should work with
// all crypto not just btc and xmr"): adding a rail is a row here plus a
// watcher — never engine surgery. scale is the atomic-unit power (the
// piconero class bug is what every future row must get right), depth is the
// confirmation count, chain is how the chain itself keeps amounts:
//   transparent     — amounts are public (btc): the chain self-attests and
//                     the stats word is "proven".
//   hidden-amount   — amounts are hidden (xmr): a txid proves existence,
//                     not value, and the stats word is "recorded".
// LOCKED constraints that do not widen with the table: escrow stays
// BTC-only 2-of-2 — any other asset rides a direct deal; the vendor's own
// wallet is never a chain confirmation; only a watcher is.
export const ASSETS = {
  btc: { scale: 8, depth: 3, chain: 'transparent' },
  xmr: { scale: 12, depth: 10, chain: 'hidden-amount' },
};

// The one stats word per chain class: the short tag a bulletin's reader
// carries inside an entry (phrasing: 'proven'), kept apart from the
// verbatim banner sentence that phrasingFor speaks for a screen.
export const CHAIN_WORD = {
  transparent: 'proven',
  'hidden-amount': 'recorded',
};

// A currency this device trades, or null. Every "is this a coin" check on
// every rail reads this one answer, so a new row is live everywhere it
// should be and nowhere it should not.
export function assetOf(currency) {
  return ASSETS[String(currency || '').toLowerCase()] || null;
}

// The rails the stats law can speak for.
export const RAILS = Object.keys(ASSETS);

export function confirmationsRequired(currency, overrides = {}) {
  const key = String(currency || '').toLowerCase();
  const fallback = ASSETS[key]?.depth ?? 10;
  const chosen = overrides && overrides[key] != null ? overrides[key] : fallback;
  const count = Number(chosen);
  if (!Number.isInteger(count) || count < 1) return fallback;
  return count;
}

// One amount parser for the whole trade. Dollars signs and commas are copy,
// trailing zeros are representation. It throws on anything that is not a
// plain decimal, including exponent notation, and it never rounds — half-up
// rounding is a watcher report's job, never an order's. (security S7)
export function normalizeAmount(value) {
  const raw = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : String(value ?? '').trim().replace(/[$,]/g, '');
  if (!raw || /e/i.test(raw) || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('The amount must be a decimal string.');
  }
  const [whole, frac = ''] = raw.split('.');
  const digits = whole.replace(/^0+(?=\d)/, '') || '0';
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${digits}.${trimmed}` : digits;
}

export function orderCoinAmount(product, currency) {
  const unit = String(product?.currency || '').toLowerCase();
  const wanted = String(currency || '').toLowerCase();
  if (!assetOf(unit)) return null;
  if (unit !== wanted) return null;
  const text = String(product?.price ?? product?.amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return text;
}

// The menu item an order names. The order's product carries the listing id
// the buyer tapped, and the rows are this vendor's own published listings
// cached on this device. Only an exact id match binds; no match invents
// nothing. (security F5)
export function listedItem(product, ownListings) {
  const id = String(product?.id ?? '').trim().toLowerCase();
  if (!id || !Array.isArray(ownListings)) return null;
  return ownListings.find((row) => (
    row != null && [row.id, row.d].some((key) => String(key ?? '').trim().toLowerCase() === id)
  )) || null;
}

// What an acceptance may demand for an order, read against this vendor's own
// menu. A buyer-written price is a claim, not a price: the only amount an
// acceptance starts from is one this device sold.
//   { kind: 'listing', currency, amount } — the menu prices the item in coin;
//       the demanded amount has to cover `amount`.
//   { kind: 'dollars' }  — the order (or its own menu row) prices in dollars;
//       no chain-checked coin amount exists, so the acceptance refuses.
//   { kind: 'unit' }     — the menu prices the item in the other coin.
//   { kind: 'unbound' }  — nothing on this menu prices the item in coin, and
//       the order itself is not priced in dollars; only here does the old
//       free-amount path still run.
export function acceptanceDemand(product, ownListings, coinCurrency) {
  const listed = listedItem(product, ownListings);
  if (listed) {
    const currency = String(listed.currency || '').toLowerCase();
    if (!assetOf(currency)) return { kind: 'dollars' };
    const price = String(listed.price ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(price) || !(Number(price) > 0)) return { kind: 'unbound' };
    if (currency !== String(coinCurrency || '').toLowerCase()) return { kind: 'unit', currency };
    return { kind: 'listing', currency, amount: price };
  }
  if (String(product?.currency || '').toLowerCase() === 'usd') return { kind: 'dollars' };
  return { kind: 'unbound' };
}

export function nextPaymentState(current, event) {
  const next = NEXT[current]?.[event];
  if (!next) throw new Error(`A payment that is ${current || 'missing'} cannot ${event}.`);
  return next;
}

// The vendor's phone must not call this. A watcher you run is the only caller.
// There is no fetch here, and an empty watcher URL is a hard stop.
// `confirmed: true` on the report is not enough. The count has to clear the threshold.


function decimalUnits(value, scale) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(scale).replace(/0+$/, '').replace(/\.$/, '')
    : String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  if (frac.length > scale) return null;
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt((frac || '0').padEnd(scale, '0'));
}

// Whole coins as exact integer units. Null when the value is not a plain
// decimal, or is finer than the currency allows.
export function coinUnits(value, currency) {
  const asset = assetOf(currency);
  if (!asset) return null;
  return decimalUnits(value, asset.scale);
}

export function unitsToCoins(units, currency) {
  const asset = assetOf(currency);
  if (!asset || typeof units !== 'bigint' || units < 0n) return null;
  const factor = 10n ** BigInt(asset.scale);
  const frac = (units % factor).toString().padStart(asset.scale, '0').replace(/0+$/, '');
  return frac ? `${units / factor}.${frac}` : `${units / factor}`;
}

// The amount an acceptance locks in. Both sides of the deal read the amount
// by one rule now — the same one the watcher path uses — so an order can
// never carry a coin string the chain check cannot confirm. (security S7)
// Trailing zeros are representation and are trimmed the way receipts spell
// amounts. Nothing here rounds: half-up rounding stays where a report of a
// real transaction needs it, never in a demand.
export function acceptAmount(value, currency) {
  const text = normalizeAmount(value);
  const unit = String(currency || '').toLowerCase();
  const asset = assetOf(unit);
  if (!asset) {
    throw new Error(`Accept in a coin this device checks on chain. ${String(currency).toUpperCase()} is not one of them.`);
  }
  if (decimalUnits(text, asset.scale) == null) {
    throw new Error(`${text} is finer than ${unit.toUpperCase()} can count. The chain check could never confirm it, so ask for an amount with at most ${asset.scale} decimal places.`);
  }
  return text;
}

export function amountCovers(reported, expected, currency) {
  const asset = assetOf(currency);
  if (!asset) return false;
  const got = decimalUnits(reported, asset.scale);
  const need = decimalUnits(expected, asset.scale);
  if (got == null || need == null) return false;
  return got >= need;
}

export function applyWatcherReport({ state, watcherUrl, report, currency, threshold, amount } = {}) {
  if (!String(watcherUrl || '').trim()) {
    throw new Error('No payment watcher is set. This device does not check a block explorer.');
  }
  if (!report || report.source !== 'watcher' || !report.txid) {
    throw new Error('Only a watcher report can move a payment to seen or confirmed.');
  }
  if (amount != null && amount !== '') {
    if (report.amount == null || report.amount === '') {
      throw new Error('The watcher did not report an amount.');
    }
    if (!amountCovers(report.amount, amount, currency)) {
      throw new Error('The payment is short of the order.');
    }
  }
  let current = state;
  if (current === 'address_issued') current = nextPaymentState(current, 'see');
  const need = threshold == null ? confirmationsRequired(currency) : Number(threshold);
  const confirmed = Number(report.confirmations) >= need;
  if (confirmed) {
    if (current !== 'seen') throw new Error('A payment has to be seen before it can be confirmed.');
    current = nextPaymentState(current, 'confirm');
  }
  if (current === state) throw new Error('The watcher report did not move the payment.');
  return current;
}