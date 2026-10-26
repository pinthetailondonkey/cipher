// A payment watcher you run. The phone asks this. This process asks a Monero
// wallet RPC, or a Bitcoin node, that you point it at. Bitcoin is a
// scantxoutset scan of the address. It does not need a wallet or an index.
// It does not call a public block explorer.
//
// On Bitcoin, seen means the payment is already in a block. There is no
// zero-confirmation path, because a scan of the UTXO set cannot see a
// transaction that is only in the mempool. One or two confirmations is the
// window where the vendor can see the money and must not ship. The order
// is confirmed at three blocks, and not before.
//
//   XMR_WALLET_RPC=http://127.0.0.1:18083 BTC_RPC_URL=http://user:pass@127.0.0.1:8332 node scripts/payment-watcher.mjs
//
// GET /payment?address=&currency=xmr|btc
// 200 { txid, confirmations, amount, outputAmount, time } or { pending: true },
//     signed with `x-cipher-sig: v1=<hex hmac-sha256>` over the raw body bytes
//     (the watch token is the key) and `x-cipher-ts` in unix seconds. The phone
//     rejects an unsigned or stale answer, so only the watcher's own word
//     moves an order. `time` is the block or event time of the transfer, in
//     unix seconds, and the oldest one in the covering set. The phone uses it
//     to refuse a transfer recorded before the order's address was issued.
// 503 { error } when that currency's node is not configured.
//
// Every amount leaves here in whole coins, as a decimal string. Monero wallet
// RPC answers in piconero, so it is shifted twelve places before it enters the
// report. `amount` is the sum of every output to the address. `outputAmount`
// and `txid` are the largest single output, which is what a receipt names.
//
// Monero direction. The wallet's `get_transfers` answers come in buckets:
// `in` is a transfer that arrived and is mined, `pool` is one that arrived and
// is still unconfirmed, and `pending`, `out` and `failed` are this wallet's
// own sends. This watcher asks only for `in` and `pool`, and
// `src/lib/paymentWatch.js` checks every row's own label again, dropping a row
// marked `pending`, `out` or `failed` even if the wallet filed it wrong. The
// vendor's own outgoing spend can therefore never be read as an incoming
// payment. (security S3)

import http from 'node:http';
import fs from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { incomingMoneroTransfers, parseExactAmounts, reportFromTransfers, rowsFromScan } from '../src/lib/paymentWatch.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || process.env.WATCH_PORT || 8788);
const xmrRpc = String(process.env.XMR_WALLET_RPC || '').trim();
const btcRpc = String(process.env.BTC_RPC_URL || '').trim();
const watchToken = String(process.env.WATCH_TOKEN || '');

function tokenMatches(presented) {
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(watchToken);
  if (!watchToken || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Every 200 answer is signed so the phone can tell a forged report from a real
// one. The signature covers the exact body bytes; the watch token is the key.
// The phone also checks `x-cipher-ts` is within two minutes of its own clock.
function signedAnswer(res, report) {
  const body = JSON.stringify(report);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `v1=${createHmac('sha256', watchToken).update(body).digest('hex')}`;
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-cipher-sig': sig, 'x-cipher-ts': String(ts) });
  res.end(body);
}

async function rpc(url, body, { exactAmounts = false } = {}) {
  const parsed = new URL(url);
  const headers = { 'Content-Type': 'application/json' };
  if (parsed.username || parsed.password) {
    const token = Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
    parsed.username = '';
    parsed.password = '';
  }
  const response = await fetch(parsed.href, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Wallet RPC answered ${response.status}`);
  const text = await response.text();
  const payload = exactAmounts ? parseExactAmounts(text) : JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message || 'Wallet RPC rejected the request');
  return payload.result;
}

async function moneroTransfers(address) {
  const result = await rpc(`${xmrRpc.replace(/\/$/, '')}/json_rpc`, {
    jsonrpc: '2.0',
    id: '0',
    method: 'get_transfers',
    // Arriving transfers only. `pending` and `out` are this wallet's own
    // sends; asking for them would feed money leaving into a check for
    // money arriving. incomingMoneroTransfers enforces the same filter row
    // by row. (security S3)
    params: { in: true, pool: true },
  }, { exactAmounts: true });
  const rows = incomingMoneroTransfers(result);
  return reportFromTransfers(rows, address, 'xmr');
}

function bitcoinDescriptor(address) {
  const text = String(address || '').trim();
  if (!/^(bc1|tb1|bcrt1|[123mn2])[a-zA-Z0-9]{10,100}$/.test(text)) {
    throw Object.assign(new Error('That is not a Bitcoin address this watcher can scan.'), { status: 400 });
  }
  return `addr(${text})`;
}

// scantxoutset cannot date its unspents, so each mined block height is asked
// for its time. A height the node cannot date stays undated, and the phone
// then refuses to confirm an order from an undated transfer. (security S1)
async function bitcoinBlockTimes(heights) {
  const rows = await Promise.all([...new Set(heights.filter(Number.isInteger))].map(async (height) => {
    try {
      const stats = await rpc(btcRpc, {
        jsonrpc: '1.0',
        id: 'cipher',
        method: 'getblockstats',
        params: [height, ['time']],
      });
      const time = Number(stats?.time);
      return Number.isFinite(time) && time > 0 ? [height, time] : null;
    } catch {
      return null;
    }
  }));
  return new Map(rows.filter(Boolean));
}

async function bitcoinTransfers(address) {
  const scan = await rpc(btcRpc, {
    jsonrpc: '1.0',
    id: 'cipher',
    method: 'scantxoutset',
    params: ['start', [bitcoinDescriptor(address)]],
  });
  const rows = rowsFromScan(scan, address);
  const times = await bitcoinBlockTimes(rows.map((row) => row.height));
  for (const row of rows) if (times.has(row.height)) row.timestamp = times.get(row.height);
  return reportFromTransfers(rows, address, 'btc');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method !== 'GET' || url.pathname !== '/payment') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const address = url.searchParams.get('address') || '';
  const currency = (url.searchParams.get('currency') || '').toLowerCase();
  const header = String(req.headers.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') || '');
  if (!watchToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Set WATCH_TOKEN. This watcher refuses an open check.' }));
    return;
  }
  if (!tokenMatches(presented)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'The watcher token is wrong.' }));
    return;
  }
  try {
    let report;
    if (currency === 'xmr') {
      if (!xmrRpc) throw Object.assign(new Error('This watcher has no Monero wallet.'), { status: 503 });
      report = await moneroTransfers(address);
    } else if (currency === 'btc') {
      if (!btcRpc) throw Object.assign(new Error('This watcher has no Bitcoin wallet.'), { status: 503 });
      report = await bitcoinTransfers(address);
    } else {
      throw Object.assign(new Error('Say currency=xmr or currency=btc.'), { status: 400 });
    }
    signedAnswer(res, report);
  } catch (error) {
    const status = error.status || 502;
    console.error('[watcher]', error.message);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || 'The watcher failed.' }));
  }
});

if (process.argv[1] && process.argv[1].endsWith('payment-watcher.mjs')) {
  if (!watchToken || (!xmrRpc && !btcRpc)) {
    console.error('[watcher] A vendor runs this. It will not listen until both of these are set:');
    console.error('  WATCH_TOKEN=a-long-secret');
    console.error('  XMR_WALLET_RPC=http://127.0.0.1:18083   or   BTC_RPC_URL=http://user:pass@127.0.0.1:8332');
    console.error('Start the Monero wallet first:');
    console.error('  monero-wallet-rpc --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18083 --disable-rpc-login --wallet-file YOUR_WALLET --password YOUR_PASSWORD');
    console.error('Then: WATCH_TOKEN=a-long-secret XMR_WALLET_RPC=http://127.0.0.1:18083 npm run watch');
    console.error('Paste http://THIS_MACHINE:8788/payment?token=a-long-secret into Connections. The phone never calls a block explorer.');
    process.exit(1);
  }
  server.listen(port, '0.0.0.0', () => {
    console.log(`[watcher] http://127.0.0.1:${port}/payment?token=${watchToken}`);
    if (!xmrRpc) console.log('[watcher] XMR_WALLET_RPC is not set. Monero checks will fail loudly.');
    if (!btcRpc) console.log('[watcher] BTC_RPC_URL is not set. Bitcoin checks will fail loudly.');
    console.log('[watcher] The phone confirms Bitcoin at 3 and Monero at 10, unless cipher_confirmations overrides it.');
    console.log('[watcher] Paste that URL into Connections. This process asks your wallet. It does not ask a block explorer.');
  });
}

export { server };
