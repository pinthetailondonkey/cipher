// Exercise the operator setup path in a disposable directory: key generation,
// .env loading, a real local watcher HTTP server, synthetic wallet RPC, and the
// production payment verifier. No key or wallet data leaves this process.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPayment, childWatcherToken } from '../src/lib/paymentWatch.js';
import { pinPaymentWatcherKey } from '../src/lib/paymentWatcherTrust.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envNames = [
  'WATCH_TOKEN', 'WATCH_SIGNING_PRIVATE_KEY', 'WATCH_ALLOWED_ORIGINS',
  'XMR_WALLET_RPC', 'BTC_RPC_URL', 'WATCH_PORT', 'PORT', 'WATCH_HOST',
];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const priorCwd = process.cwd();
const priorLocalStorage = globalThis.localStorage;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-watcher-operator-'));
let rpc;
let watcher;

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
});

try {
  for (const name of envNames) delete process.env[name];

  // Capture the one-time keygen output in memory. The seed is written only to
  // the temporary watcher .env file and is never printed by this harness.
  const keygenOutput = execFileSync(process.execPath, [
    path.join(repo, 'scripts/payment-watcher-keygen.mjs'),
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !envNames.includes(name))),
  });
  const seed = keygenOutput.match(/^WATCH_SIGNING_PRIVATE_KEY=([A-Za-z0-9_-]+)$/m)?.[1];
  const publicKey = keygenOutput.trim().split(/\r?\n/).at(-1);
  assert.match(seed || '', /^[A-Za-z0-9_-]{43}$/);
  assert.match(publicKey || '', /^[A-Za-z0-9_-]{43}$/);

  rpc = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const query = JSON.parse(body);
    assert.equal(query.method, 'get_transfers');
    assert.deepEqual(query.params, { in: true, pool: true });
    const now = Math.floor(Date.now() / 1000);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { in: [{
      type: 'in', address: '8abc', txid: 'synthetic-operator-smoke-tx',
      amount: '500000000000', confirmations: 10, timestamp: now, unlock_time: 0,
    }], pool: [] } }));
  });
  const rpcPort = await listen(rpc);

  const baseToken = 'synthetic-operator-access-token';
  fs.writeFileSync(path.join(temp, '.env'), [
    `WATCH_TOKEN=${baseToken}`,
    `WATCH_SIGNING_PRIVATE_KEY=${seed}`,
    'WATCH_PORT=0',
    `XMR_WALLET_RPC=http://127.0.0.1:${rpcPort}`,
    '',
  ].join('\n'), { mode: 0o600 });
  process.chdir(temp);

  const memory = new Map([['cipher_active_pubkey', 'ab'.repeat(32)]]);
  globalThis.localStorage = {
    getItem(key) { return memory.get(key) ?? null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); },
    key(index) { return [...memory.keys()][index] ?? null; },
    get length() { return memory.size; },
  };

  ({ server: watcher } = await import(pathToFileURL(path.join(repo, 'scripts/payment-watcher.mjs'))));
  const watcherPort = await listen(watcher);
  const observed = [];
  watcher.on('request', (request) => {
    if (request.url?.startsWith('/payment')) {
      observed.push({ url: request.url, authorization: request.headers.authorization || '' });
    }
  });

  await pinPaymentWatcherKey(publicKey);
  const watcherUrl = `http://127.0.0.1:${watcherPort}/payment?token=${baseToken}`;
  const issuedAt = Math.floor(Date.now() / 1000) - 30;
  const result = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'seen',
    amount: '0.5',
    issuedAt,
  });

  assert.equal(result.moved, true);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.report.txid, 'synthetic-operator-smoke-tx');
  assert.equal(observed.length, 1);
  const expectedChild = await childWatcherToken(baseToken, '8abc', 'xmr');
  assert.equal(observed[0].authorization, `Bearer ${expectedChild}`);
  assert.equal(observed[0].url.includes('token='), false);
  assert.equal(observed[0].url.includes(baseToken), false);

  console.log('Watcher operator smoke passed: generated key, temporary .env, signed local report, pinned verifier, child-token header, and confirmed XMR test state. RPC and transfer were synthetic.');
} finally {
  await close(watcher);
  await close(rpc);
  process.chdir(priorCwd);
  if (priorLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = priorLocalStorage;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
