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

const LOCAL_WATCHER_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalWatcherHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return LOCAL_WATCHER_HOSTS.has(host);
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
  // An http watcher on the open internet is exactly the seat the answer
  // forger sits in. Only a localhost watcher may speak plain HTTP.
  if (url.protocol === 'http:' && !isLocalWatcherHost(url.hostname)) {
    throw new Error('A payment watcher on the open internet must use HTTPS. Paste an https watcher, or run this one on this device.');
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

// A watcher answer carries `x-cipher-sig: v1=<hex hmac-sha256>` over the exact
// raw body bytes, with the watch token as the key, and `x-cipher-ts` in unix
// seconds. An answer older or newer than 120 seconds is stale, so a captured
// answer cannot be replayed later.
const WATCHER_SIG_MAX_AGE = 120;

function hexEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function watcherSignature(rawBody, token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  let hex = '';
  for (const byte of new Uint8Array(mac)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export async function verifyWatcherResponse({ rawBody, sig, ts, token, nowSec } = {}) {
  if (typeof rawBody !== 'string' || rawBody.length === 0) return false;
  if (!/^\d+$/.test(String(ts ?? '').trim())) return false;
  const sent = Number(ts);
  const now = Number(nowSec);
  if (!Number.isInteger(now)) return false;
  if (Math.abs(now - sent) > WATCHER_SIG_MAX_AGE) return false;
  const presented = String(sig ?? '').trim();
  const match = presented.match(/^v1=([0-9a-f]{64})$/);
  if (!match) return false;
  const computed = await watcherSignature(rawBody, token);
  return hexEqual(computed, match[1]);
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
  let raw = null;
  try {
    raw = await response.text();
  } catch {
    raw = null;
  }
  if (!response.ok) {
    let errorBody = null;
    try {
      errorBody = JSON.parse(raw);
    } catch {
      errorBody = null;
    }
    throw new Error(errorBody?.error || `The payment watcher refused the check (${response.status}).`);
  }
  // Every answer is signed and freshness-checked before it can speak about the
  // chain. A missing signature or a wrong one fails closed: nothing moves.
  const sig = response.headers?.get?.('x-cipher-sig') ?? null;
  const ts = response.headers?.get?.('x-cipher-ts') ?? null;
  const verified = raw != null && await verifyWatcherResponse({ rawBody: raw, sig, ts, token, nowSec: Math.floor(Date.now() / 1000) });
  if (!verified) {
    if (sig == null && ts == null) {
      console.warn('[payments] This watcher does not sign its answers. Update your watcher, then check again.');
    } else {
      console.warn('[payments] A watcher answer failed its signature or freshness check. It was ignored.');
    }
    throw new Error('The payment watcher tried to answer, but its answer did not pass the signature check. Nothing was marked on the order.');
  }
  let body = null;
  try {
    body = parseExactAmounts(raw);
  } catch {
    body = null;
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
