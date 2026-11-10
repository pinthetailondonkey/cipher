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
// 200 { address, currency, txid, confirmations, amount, outputAmount, time } or
//     { address, currency, pending: true },
//     signed with `x-cipher-signature` using a separately configured Ed25519
//     key over the exact v2 report body. The phone rejects an unsigned,
//     re-stamped, replayed or stale answer, so only a pinned watcher's word
//     moves an order. The body echoes the address and currency it was asked
//     about: a signed reply for one order replayed as another order's check
//     is the one forgery the signature alone cannot see. (security re-attack)
//     The check token is a per-order child: HMAC of the base WATCH_TOKEN
//     over the version, currency and address exactly as asked. The phone
//     derives it before each check, so the base token never authenticates
//     a request — a token captured for one order opens nothing else, and
//     the pasted base secret is dead weight on the wire. (drill round three)
//     `time` is the block or event time of the transfer, in
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
import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import { childWatcherToken, incomingMoneroTransfers, parseExactAmounts, reportFromTransfers, rowsFromScan } from '../src/lib/paymentWatch.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || process.env.WATCH_PORT || 8788);
const xmrRpc = String(process.env.XMR_WALLET_RPC || '').trim();
const btcRpc = String(process.env.BTC_RPC_URL || '').trim();
const watchToken = String(process.env.WATCH_TOKEN || '');
const signingSecret = String(process.env.WATCH_SIGNING_PRIVATE_KEY || '');
const defaultAllowedOrigin = 'https://www.ciphermessenger.org';
const allowedOrigins = new Set(String(process.env.WATCH_ALLOWED_ORIGINS || defaultAllowedOrigin).split(',').map((origin) => origin.trim()).filter(Boolean));
function loadSigningAuthority(secret) {
  const raw = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length !== 32) return null;
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKeyText: publicKey.toString('base64url'), keyId: createHash('sha256').update(publicKey).digest('hex') };
}
const signingAuthority = loadSigningAuthority(signingSecret);
// WATCH_HOST widens the listen address back on purpose: the default is the
// machine itself, so a vendor box on Tails never serves the LAN. A phone on
// the same network sets WATCH_HOST=0.0.0.0 and gets exactly what it got before.
const watchHost = String(process.env.WATCH_HOST || '127.0.0.1');

// The check token is the order's child: HMAC of the base secret over the
// version, the currency and the address exactly as asked. The base token
// itself authenticates nothing — an open-ended token is dead, and a child
// captured for one order answers for no other address, currency or order.
async function tokenMatches(presented, address, currency) {
  const expected = await childWatcherToken(watchToken, address, currency);
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(expected);
  if (!watchToken || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Every 200 answer is signed with the separate Ed25519 report key. The access
// token can open the endpoint but cannot forge this report. The phone checks a
// pinned key, request nonce and signed timestamp before trusting the body.
// Every answer also echoes the address and currency it looked up, so a
// signed reply for one order replayed as another order's check answers
// nothing. (security re-attack)
async function signedAnswer(res, address, currency, nonce, report) {
  if (!signingAuthority) throw Object.assign(new Error('This watcher has no v2 signing key.'), { status: 503 });
  const body = JSON.stringify({ version: 2, keyId: signingAuthority.keyId, nonce, signedAt: Math.floor(Date.now() / 1000), address, currency, ...report });
  const sig = sign(null, Buffer.from(`cipher-payment-watcher-v2\n${body}`), signingAuthority.privateKey).toString('base64url');
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-cipher-signature': sig, 'x-cipher-keyid': signingAuthority.keyId });
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
  }, { exactAmounts: true });
  const rows = rowsFromScan(scan, address);
  const times = await bitcoinBlockTimes(rows.map((row) => row.height));
  for (const row of rows) if (times.has(row.height)) row.timestamp = times.get(row.height);
  return reportFromTransfers(rows, address, 'btc');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/payment') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const origin = String(req.headers.origin || '');
  if (req.method === 'OPTIONS') {
    const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase();
    const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((header) => header.trim()).filter(Boolean);
    if (!origin || !allowedOrigins.has(origin) || requestedMethod !== 'GET' || requestedHeaders.some((header) => !['authorization', 'accept'].includes(header))) {
      res.writeHead(403, { Vary: 'Origin' });
      res.end();
      return;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Accept',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, OPTIONS' });
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }
  if (origin && !allowedOrigins.has(origin)) {
    res.writeHead(403, { Vary: 'Origin' });
    res.end(JSON.stringify({ error: 'This app origin is not allowed.' }));
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'x-cipher-signature, x-cipher-keyid');
    res.setHeader('Vary', 'Origin');
  }
  const address = url.searchParams.get('address') || '';
  const currency = (url.searchParams.get('currency') || '').toLowerCase();
  const nonce = url.searchParams.get('nonce') || '';
  const header = String(req.headers.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!watchToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Set WATCH_TOKEN. This watcher refuses an open check.' }));
    return;
  }
  if (!(await tokenMatches(presented, address, currency))) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'The watcher token is wrong.' }));
    return;
  }
  if (!signingAuthority || !/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Set a v2 signing key and request nonce.' }));
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
    await signedAnswer(res, address, currency, nonce, report);
  } catch (error) {
    const status = error.status || 502;
    console.error('[watcher]', error.message);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || 'The watcher failed.' }));
  }
});

if (process.argv[1] && process.argv[1].endsWith('payment-watcher.mjs')) {
  if (!watchToken || !signingAuthority || (!xmrRpc && !btcRpc)) {
    console.error('[watcher] Set the access token, v2 signing key, and at least one wallet RPC before starting:');
    console.error('  WATCH_TOKEN=a-long-secret');
    console.error('  WATCH_SIGNING_PRIVATE_KEY=<32-byte base64url Ed25519 seed; generate with npm run watch:keygen>');
    console.error('  XMR_WALLET_RPC=http://127.0.0.1:18083   or   BTC_RPC_URL=http://user:pass@127.0.0.1:8332');
    console.error('Start the Monero wallet first:');
    console.error('  monero-wallet-rpc --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18083 --disable-rpc-login --wallet-file YOUR_WALLET --password YOUR_PASSWORD');
    console.error('Then: WATCH_TOKEN=a-long-secret WATCH_SIGNING_PRIVATE_KEY=... XMR_WALLET_RPC=http://127.0.0.1:18083 npm run watch');
    console.error('Paste the watcher URL in Connections and pin this public key:');
    if (signingAuthority) console.error(`  ${signingAuthority.publicKeyText}`);
    process.exit(1);
  }
  server.listen(port, watchHost, () => {
    console.log(`[watcher] http://127.0.0.1:${port}/payment`);
    console.log(`[watcher] Pin this Ed25519 public key in Connections: ${signingAuthority.publicKeyText}`);
    if (watchHost !== '127.0.0.1') console.log(`[watcher] Listening on ${watchHost}. Any device on this network can ask this watcher.`);
    console.log('[watcher] To serve this box as an onion service instead, add to torrc:');
    console.log('[watcher]   HiddenServiceDir /var/lib/tor/cipher-watcher/');
    console.log(`[watcher]   HiddenServicePort 80 127.0.0.1:${port}`);
    console.log('[watcher] then reload tor; the .onion name sits in that directory\'s hostname file.');
    console.log('[watcher] An onion needs a TLS certificate before the phone will call it over https. Plain http is refused except on this same machine.');
    if (!xmrRpc) console.log('[watcher] XMR_WALLET_RPC is not set. Monero checks will fail loudly.');
    if (!btcRpc) console.log('[watcher] BTC_RPC_URL is not set. Bitcoin checks will fail loudly.');
    console.log('[watcher] The phone confirms Bitcoin at 3 and Monero at 10, unless cipher_confirmations overrides it.');
    console.log('[watcher] Paste that URL into Connections. This process asks your wallet. It does not ask a block explorer.');
  });
}

export { server };
