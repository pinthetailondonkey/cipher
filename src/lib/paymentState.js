const NEXT = {
  created: { issue: 'address_issued' },
  address_issued: { see: 'seen' },
  seen: { confirm: 'confirmed' },
};

const DEFAULT_CONFIRMATIONS = { btc: 3, xmr: 10 };

export function confirmationsRequired(currency, overrides = {}) {
  const key = String(currency || '').toLowerCase();
  const fallback = DEFAULT_CONFIRMATIONS[key] ?? 10;
  const chosen = overrides && overrides[key] != null ? overrides[key] : fallback;
  const count = Number(chosen);
  if (!Number.isInteger(count) || count < 1) return fallback;
  return count;
}

export function nextPaymentState(current, event) {
  const next = NEXT[current]?.[event];
  if (!next) throw new Error(`A payment that is ${current || 'missing'} cannot ${event}.`);
  return next;
}

// The vendor's phone must not call this. A watcher you run is the only caller.
// There is no fetch here, and an empty watcher URL is a hard stop.
// `confirmed: true` on the report is not enough. The count has to clear the threshold.
const SCALE = { btc: 8, xmr: 12 };

function decimalUnits(value, scale) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(scale).replace(/0+$/, '').replace(/\.$/, '')
    : String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  if (frac.length > scale) return null;
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt((frac || '0').padEnd(scale, '0'));
}

function amountCovers(reported, expected, currency) {
  const scale = SCALE[String(currency || '').toLowerCase()];
  if (scale == null) return false;
  const got = decimalUnits(reported, scale);
  const need = decimalUnits(expected, scale);
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
  if (amount != null && amount !== '' && !amountCovers(report.amount, amount, currency)) {
    throw new Error('The payment is short of the order.');
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