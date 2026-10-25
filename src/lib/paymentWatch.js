import { applyWatcherReport, coinUnits, confirmationsRequired, unitsToCoins } from './paymentState.js';
import { scopedGet } from './storage.js';

// Public explorers. Pasting one is still a block-explorer call, so it is refused
// before any request. A watcher you run is a different host.
const EXPLORERS = [
  'mempool.space',
  'blockstream.info',
  'blockchain.info',
  'blockchain.com',
  'blockchair.com',
  'blockcypher.com',
  'xmrchain.net',
  'moneroblocks.info',
  'localmonero.co',
];

export function isPublicExplorer(value) {
  let host = '';
  try {
    host = new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  return EXPLORERS.some((name) => host === name || host.endsWith(`.${name}`));
}

export function paymentWatchUrl(watcherUrl, { address, currency } = {}) {
  const raw = String(watcherUrl || '').trim();
  if (!raw) throw new Error('No payment watcher is set. This device does not check a block explorer.');
  if (isPublicExplorer(raw)) throw new Error('That host is a block explorer. This device will not call it. Paste a watcher you run.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The payment watcher address is not a URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The payment watcher address is not a URL.');
  }
  const token = url.searchParams.get('token') || '';
  if (!token) throw new Error('The payment watcher URL needs a token.');
  url.searchParams.set('address', String(address || '').trim());
  url.searchParams.set('currency', String(currency || '').trim());
  url.searchParams.set('token', token);
  return url.href;
}

// Whole coins as a canonical decimal string. Bitcoin Core already answers in
// whole coins, so this only fixes the form, not the unit.
function wholeCoins(value, currency) {
  const units = coinUnits(value, currency);
  return units == null ? null : unitsToCoins(units, currency);
}

// Monero wallet RPC answers in piconero. The integer is shifted twelve places
// as a BigInt, never divided as a float. Anything that is not a whole number
// of atomic units is dropped, so it cannot be counted toward the order.
export function atomicToCoins(value, currency) {
  let units;
  if (typeof value === 'bigint') units = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    units = BigInt(value);
  } else {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    units = BigInt(text);
  }
  return unitsToCoins(units, currency);
}

// A piconero amount can pass 2^53, where JSON.parse would round it. Quote
// every integer amount before parsing so no digit is lost.
export function parseExactAmounts(text) {
  return JSON.parse(String(text).replace(/("amount"\s*:\s*)(\d+)/g, '$1"$2"'));
}

export function moneroRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const { amount, ...rest } = row || {};
    const coins = atomicToCoins(amount, 'xmr');
    return coins == null ? rest : { ...rest, amount: coins };
  });
}

export function rowsFromScan(scan, address) {
  const tip = Number.isInteger(scan?.height) ? scan.height : null;
  return (Array.isArray(scan?.unspents) ? scan.unspents : [])
    .filter((row) => row?.txid)
    .map((row) => {
      const counted = Number.isInteger(row.confirmations)
        ? row.confirmations
        : (tip != null && Number.isInteger(row.height) ? tip - row.height + 1 : 0);
      const out = { txid: String(row.txid), address, confirmations: counted };
      const coins = wholeCoins(row.amount, 'btc');
      if (coins != null) out.amount = coins;
      return out;
    });
}

function largestUnspent(rows, currency) {
  // A receipt names one transaction, so the report names the largest output.
  // Two of the same size take the greater txid, which does not change between scans.
  const units = (row) => coinUnits(row.amount, currency) ?? -1n;
  return [...rows].sort((a, b) => {
    const left = units(a);
    const right = units(b);
    if (left !== right) return right > left ? 1 : -1;
    return String(b.txid).localeCompare(String(a.txid));
  })[0];
}

export function reportFromTransfers(transfers, address, currency) {
  const wanted = String(address || '').trim();
  const rows = (Array.isArray(transfers) ? transfers : []).filter((row) => row && (row.address === wanted || row.addr === wanted) && row.txid);
  const hit = rows.length ? largestUnspent(rows, currency) : null;
  if (!hit) return { pending: true };
  // A payment split across outputs covers the order by its sum. It is only as
  // deep as its shallowest part, so the sum cannot confirm before every part does.
  const counted = rows.filter((row) => coinUnits(row.amount, currency) != null);
  const depthOf = counted.length ? counted : [hit];
  const confirmations = Math.min(...depthOf.map((row) => Number(row.confirmations) || 0));
  const report = {
    source: 'watcher',
    txid: String(hit.txid),
    confirmations,
    confirmed: confirmations >= confirmationsRequired(currency),
  };
  if (counted.length) {
    const sum = counted.reduce((total, row) => total + coinUnits(row.amount, currency), 0n);
    report.amount = unitsToCoins(sum, currency);
    const largest = coinUnits(hit.amount, currency);
    if (largest != null) report.outputAmount = unitsToCoins(largest, currency);
  }
  return report;
}

export async function checkPayment({ watcherUrl, address, currency, state, amount, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = paymentWatchUrl(watcherUrl, { address, currency });
  if (!String(address || '').trim()) throw new Error('This order has no payment address to check.');
  const token = new URL(endpoint).searchParams.get('token');
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  } catch (error) {
    console.error('[payments] Watcher did not answer:', error);
    throw new Error('The payment watcher did not answer.');
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(body?.error || `The payment watcher refused the check (${response.status}).`);
  }
  if (!body || body.pending || !body.txid) return { moved: false, state };
  const report = {
    source: 'watcher',
    txid: String(body.txid),
    confirmations: Number(body.confirmations) || 0,
  };
  if (body.amount != null) report.amount = body.amount;
  if (body.outputAmount != null) report.outputAmount = body.outputAmount;
  try {
    const next = applyWatcherReport({
      state,
      watcherUrl,
      report,
      currency,
      amount,
      threshold: confirmationsRequired(currency, scopedGet('confirmations', {}) || {}),
    });
    return { moved: true, state: next, report };
  } catch (error) {
    if (/short of the order/.test(error.message)) return { moved: false, short: true, state };
    if (/did not move/.test(error.message)) return { moved: false, state };
    throw error;
  }
}
