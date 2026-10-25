import { applyWatcherReport } from './paymentState.js';

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
  url.searchParams.set('address', String(address || '').trim());
  url.searchParams.set('currency', String(currency || '').trim());
  return url.href;
}

export function reportFromTransfers(transfers, address) {
  const wanted = String(address || '').trim();
  const hit = (Array.isArray(transfers) ? transfers : []).find((row) => row && (row.address === wanted || row.addr === wanted) && row.txid);
  if (!hit) return { pending: true };
  const confirmations = Number(hit.confirmations) || 0;
  return {
    source: 'watcher',
    txid: String(hit.txid),
    confirmations,
    confirmed: hit.confirmed === true || confirmations >= 10,
  };
}

export async function checkPayment({ watcherUrl, address, currency, state, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = paymentWatchUrl(watcherUrl, { address, currency });
  if (!String(address || '').trim()) throw new Error('This order has no payment address to check.');
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { Accept: 'application/json' } });
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
    confirmed: body.confirmed === true,
  };
  try {
    const next = applyWatcherReport({ state, watcherUrl, report });
    return { moved: true, state: next, report };
  } catch (error) {
    if (/did not move/.test(error.message)) return { moved: false, state };
    throw error;
  }
}
