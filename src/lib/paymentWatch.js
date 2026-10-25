import { applyWatcherReport, confirmationsRequired } from './paymentState.js';
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

export function rowsFromScan(scan, address) {
  const tip = Number.isInteger(scan?.height) ? scan.height : null;
  return (Array.isArray(scan?.unspents) ? scan.unspents : [])
    .filter((row) => row?.txid)
    .map((row) => {
      const counted = Number.isInteger(row.confirmations)
        ? row.confirmations
        : (tip != null && Number.isInteger(row.height) ? tip - row.height + 1 : 0);
      return { txid: String(row.txid), address, confirmations: counted, amount: row.amount };
    });
}

function largestUnspent(rows) {
  // A receipt names one transaction. Summing every unspent would cover the
  // order and then have no txid to sign, so the report names the largest.
  // Two of the same size take the greater txid, which does not change between scans.
  return [...rows].sort((a, b) => {
    const left = Number(a.amount) || 0;
    const right = Number(b.amount) || 0;
    if (left !== right) return right - left;
    return String(b.txid).localeCompare(String(a.txid));
  })[0];
}

export function reportFromTransfers(transfers, address, currency) {
  const wanted = String(address || '').trim();
  const rows = (Array.isArray(transfers) ? transfers : []).filter((row) => row && (row.address === wanted || row.addr === wanted) && row.txid);
  const hit = rows.length ? largestUnspent(rows) : null;
  if (!hit) return { pending: true };
  const confirmations = Number(hit.confirmations) || 0;
  const report = {
    source: 'watcher',
    txid: String(hit.txid),
    confirmations,
    confirmed: confirmations >= confirmationsRequired(currency),
  };
  if (hit.amount != null) report.amount = hit.amount;
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
    if (/did not move/.test(error.message)) return { moved: false, state };
    throw error;
  }
}
