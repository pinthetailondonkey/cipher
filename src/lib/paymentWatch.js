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
    host = new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  // A lookalike trades on a seed's own name: xmrchain.net.evil.tld is no
  // child of xmrchain.net, but the plain check read it as a watcher you run
  // and handed it the token. Any host carrying a seed's name answers for it,
  // so it is refused as one. (security re-attack)
  return EXPLORERS.some((name) => host === name || host.endsWith(`.${name}`) || host.includes(name));
}

const LOCAL_WATCHER_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalWatcherHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return LOCAL_WATCHER_HOSTS.has(host);
}

// ————— per-order child token —————
// A watcher answer is signed with the token, so whoever holds the token can
// forge chain truth for ANY address on that watcher, forever. The pasted
// watcher URL carries that base token, and anything that copies the URL
// (a screen share, a synced backup) captures exactly that unbounded key.
// The check now derives a child token bound to the exact payment asked
// about: HMAC of the base secret over a version string, the currency and
// the address. The watcher recomputes the child from its own secret and the
// requested payment, so the base token never authenticates a check at all
// — an open-ended token is dead on the wire — and a captured child answers
// for one address and one currency only. Orders are checked on per-order
// derived addresses (the shared-address case is refused before any check),
// so a captured child holds nothing once its order is settled or dead,
// wherever the base token still sits.
const CHILD_TOKEN_VERSION = 'cipher-watch-v1';

export async function childWatcherToken(baseToken, address, currency) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(baseToken || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${CHILD_TOKEN_VERSION}:${String(currency || '').trim().toLowerCase()}:${String(address || '').trim()}`),
  );
  let hex = '';
  for (const byte of new Uint8Array(mac)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function paymentWatchUrl(watcherUrl, { address, currency, token } = {}) {
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
  // Callers that know the payment pass the child token; the pasted base
  // token is only the fallback, and a check never sends it.
  const watchToken = token || url.searchParams.get('token') || '';
  if (!watchToken) throw new Error('The payment watcher URL needs a token.');
  url.searchParams.set('address', String(address || '').trim());
  url.searchParams.set('currency', String(currency || '').trim());
  url.searchParams.set('token', watchToken);
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

// A piconero amount can pass 2^53, where JSON.parse would round it, and a
// bitcoin amount parsed as a number is a binary float. Quote every plain
// number under an "amount" key before parsing so no digit is lost and no
// amount ever becomes a float.
export function parseExactAmounts(text) {
  return JSON.parse(String(text).replace(/("amount"\s*:\s*)(\d+(?:\.\d+)?)(?![\d.eE])/g, '$1"$2"'));
}

export function moneroRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const { amount, ...rest } = row || {};
    const coins = atomicToCoins(amount, 'xmr');
    return coins == null ? rest : { ...rest, amount: coins };
  });
}

// The wallet's `get_transfers` buckets label what each row is: `in` is a
// transfer that arrived and is mined, `pool` is one that arrived and is still
// unconfirmed, and `pending`, `out` and `failed` are this wallet's own sends,
// money leaving, not arriving. An order watches for money coming in, so only
// the arriving buckets are ever read, and a row whose own label says it is a
// send is dropped even if the wallet filed it in the wrong bucket. A
// direction-blind answer would let the vendor's own outgoing spend satisfy an
// inbound payment check. (security S3)
export function incomingMoneroTransfers(result, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const rows = [];
  for (const bucket of [result?.in, result?.pool]) {
    for (const row of (Array.isArray(bucket) ? bucket : [])) {
      if (!row) continue;
      const label = String(row.type ?? row.direction ?? '').toLowerCase();
      if (!(label === '' || label === 'in' || label === 'pool')) continue;
      if (!moneroRowCountable(row, nowSec)) continue;
      rows.push(row);
    }
  }
  return moneroRows(rows);
}

// A Monero row can arrive and still not be money in hand. `double_spend_seen`
// says the wallet saw a conflicting spend of the same inputs, so the row may
// never mine. `unlock_time` locks the output: below 500,000,000 it is a block
// height and the output is locked until the chain reaches it; at or above it
// is a unix time, locked until the clock passes it. Either way the row is held
// out of the count, so the order reads it as not arrived yet and the next
// check, once it unlocks, counts it. A mined row's tip is its block height plus
// its confirmations minus one; a pool row has no block, so a height-style lock
// on it cannot be shown to have passed and it stays held. A value that is not a
// plain count of blocks or seconds is held too. Fail closed.
const UNLOCK_TIME_IS_UNIX = 500000000;

function moneroRowCountable(row, nowSec) {
  const flag = row.double_spend_seen;
  if (flag === true || flag === 1 || String(flag ?? '').toLowerCase() === 'true') return false;
  if (row.unlock_time == null) return true;
  const text = String(row.unlock_time).trim();
  if (!/^\d+$/.test(text)) return false;
  const unlock = Number(text);
  if (unlock === 0) return true;
  if (unlock >= UNLOCK_TIME_IS_UNIX) return !(unlock > Number(nowSec));
  const height = Number(row.height);
  const confirmations = Number(row.confirmations);
  if (!Number.isInteger(height) || height < 1 || !Number.isInteger(confirmations) || confirmations < 1) return false;
  return unlock <= height + confirmations - 1;
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
      if (Number.isInteger(row.height)) out.height = row.height;
      const coins = wholeCoins(row.amount, 'btc');
      if (coins != null) out.amount = coins;
      return out;
    });
}

// A receipt names one transaction, so a report is built from one transaction
// only: the outputs of a single txid, summed. Of the transactions that paid
// the address, the one with the greatest total is named; two of the same total
// take the greater txid, which does not change between scans. Another
// transaction to the same address never adds to it, so a payment split across
// two transactions is short of the order until one of them covers it by itself.
function chosenTransaction(rows, currency) {
  const byTx = new Map();
  for (const row of rows) {
    const key = String(row.txid);
    const units = coinUnits(row.amount, currency);
    const entry = byTx.get(key) || { txid: key, rows: [], total: 0n, counted: 0 };
    entry.rows.push(row);
    if (units != null) { entry.total += units; entry.counted += 1; }
    byTx.set(key, entry);
  }
  return [...byTx.values()].sort((a, b) => {
    if (a.total !== b.total) return b.total > a.total ? 1 : -1;
    return b.txid.localeCompare(a.txid);
  })[0];
}

export function reportFromTransfers(transfers, address, currency) {
  const wanted = String(address || '').trim();
  const rows = (Array.isArray(transfers) ? transfers : []).filter((row) => row && (row.address === wanted || row.addr === wanted) && row.txid);
  const tx = rows.length ? chosenTransaction(rows, currency) : null;
  if (!tx) return { pending: true };
  // Outputs of the one transaction. It is only as deep as its shallowest
  // output, so the sum cannot confirm before every part does.
  const counted = tx.rows.filter((row) => coinUnits(row.amount, currency) != null);
  const depthOf = counted.length ? counted : tx.rows;
  const confirmations = Math.min(...depthOf.map((row) => Number(row.confirmations) || 0));
  const report = {
    source: 'watcher',
    txid: tx.txid,
    confirmations,
    confirmed: confirmations >= confirmationsRequired(currency),
  };
  if (counted.length) {
    report.amount = unitsToCoins(tx.total, currency);
    const largest = counted.reduce((top, row) => {
      const units = coinUnits(row.amount, currency);
      return units > top ? units : top;
    }, 0n);
    report.outputAmount = unitsToCoins(largest, currency);
  }
  // When the chain dates every part of the transfer, the report carries the
  // oldest date. The order that consumes the txid can then refuse one that
  // was recorded before its address even existed. (security S1)
  const dates = counted.map((row) => Number(row.timestamp));
  if (counted.length && dates.every((value) => Number.isFinite(value) && value > 0)) {
    report.time = Math.min(...dates);
  }
  return report;
}

// A transfer whose block or event time sits before the order's address was
// issued belongs to whatever that address held earlier, never to this order.
// An order can only consume a txid recorded at or after its issuance. (security S1)
export function issuePrecedes(report, issuedAtSec) {
  const issuedAt = Number(issuedAtSec);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  const time = Number(report?.time);
  if (!Number.isFinite(time) || time <= 0) return false;
  return time < issuedAt;
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

async function watcherSignature(rawBody, token, ts) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // The timestamp is inside the signed bytes. A captured answer replayed
  // with a re-stamped date verified under a bare-body HMAC; with the date
  // covered, a replay's stamp no longer matches and freshness bites. (security F6)
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${rawBody}`));
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
  const computed = await watcherSignature(rawBody, token, String(ts).trim());
  return hexEqual(computed, match[1]);
}

export async function checkPayment({ watcherUrl, address, currency, state, amount, issuedAt, fetchImpl = globalThis.fetch } = {}) {
  // The paste itself is validated first — explorer, scheme, host, token
  // presence — so a bad watcher fails with its own words, not a crypto
  // error from deriving over an empty secret. Then the check walks out the
  // door with the order's child token, never the base secret.
  const paste = String(watcherUrl || '').trim();
  paymentWatchUrl(paste, { address, currency });
  let baseToken = '';
  try { baseToken = new URL(paste).searchParams.get('token') || ''; } catch {}
  const child = await childWatcherToken(baseToken, address, currency);
  const endpoint = paymentWatchUrl(paste, { address, currency, token: child });
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
  if (!body) return { moved: false, state };
  // Every answer now names the payment it answers for. A signed reply for
  // one order played onto another is the replay the signature cannot see:
  // the bytes are honest, the ask is not. Only an echo of the exact address
  // and currency this check asked for builds a report, and a watcher too
  // old to echo fails closed — update it. (security re-attack)
  const asked = String(address || '').trim();
  const askedCurrency = String(currency || '').trim().toLowerCase();
  if (body.address !== asked || String(body.currency || '').trim().toLowerCase() !== askedCurrency) {
    throw new Error('This watcher\'s answer does not name the payment this check asked about. Update your watcher, then check again.');
  }
  if (body.pending || !body.txid) return { moved: false, state };
  const report = {
    source: 'watcher',
    txid: String(body.txid),
    confirmations: Number(body.confirmations) || 0,
  };
  if (body.amount != null) report.amount = body.amount;
  if (body.outputAmount != null) report.outputAmount = body.outputAmount;
  if (body.time != null) report.time = body.time;
  // The dates are unix seconds — bitcoin's epoch up through a few hours
  // past this device's clock. Anything else is a unit crossing, most likely
  // milliseconds, and a milliseconds value sails past every issuance
  // comparison as "the future". It carries no weight instead of lying.
  if (report.time != null) {
    const now = Math.floor(Date.now() / 1000);
    const time = Number(report.time);
    if (!Number.isFinite(time) || time < 1231006505 || time > now + 7200) {
      delete report.time;
    }
  }
  // A transfer the chain dates before this order's address was issued is
  // refused before anything moves, seen or confirmed. (security S1)
  if (issuePrecedes(report, issuedAt)) {
    console.warn('[payments] The transfer the watcher reported was recorded before this order\'s address was issued. It cannot pay this order.');
    return { moved: false, stale: true, state };
  }
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
