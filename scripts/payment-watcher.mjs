// A payment watcher you run. The phone asks this. This process asks a wallet
// RPC you point it at. It does not call a public block explorer.
//
//   XMR_WALLET_RPC=http://127.0.0.1:18083 BTC_RPC_URL=http://user:pass@127.0.0.1:8332 node scripts/payment-watcher.mjs
//
// GET /payment?address=&currency=xmr|btc
// 200 { txid, confirmations } or { pending: true }
// 503 { error } when that currency's wallet is not configured.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { reportFromTransfers } from '../src/lib/paymentWatch.js';

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

async function rpc(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Wallet RPC answered ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Wallet RPC rejected the request');
  return payload.result;
}

async function moneroTransfers(address) {
  const result = await rpc(`${xmrRpc.replace(/\/$/, '')}/json_rpc`, {
    jsonrpc: '2.0',
    id: '0',
    method: 'get_transfers',
    params: { in: true, pending: true, pool: true },
  });
  const rows = [...(result?.in || []), ...(result?.pending || []), ...(result?.pool || [])];
  return reportFromTransfers(rows, address);
}

async function bitcoinTransfers(address) {
  const result = await rpc(btcRpc, {
    jsonrpc: '1.0',
    id: 'cipher',
    method: 'listtransactions',
    params: ['*', 200],
  });
  const rows = (Array.isArray(result) ? result : []).filter((row) => row.category === 'receive');
  return reportFromTransfers(rows, address);
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
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
