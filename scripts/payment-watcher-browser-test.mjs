import assert from 'node:assert/strict';
import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-watcher-browser-'));
process.chdir(cleanCwd); // Keep the watcher module from loading any workspace .env.

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server?.close(() => resolve()));
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

const app = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><html><body>watcher CORS fixture</body></html>');
});
const refusedApp = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><html><body>refused origin fixture</body></html>');
});
const rpc = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const query = JSON.parse(raw);
  assert.equal(query.method, 'get_transfers');
  assert.deepEqual(query.params, { in: true, pool: true });
  json(response, 200, { result: { in: [{
    type: 'in', address: '8abc', txid: 'synthetic-browser-rpc-tx', amount: '500000000000',
    confirmations: 10, timestamp: Math.floor(Date.now() / 1000), unlock_time: 0,
  }], pool: [] } });
});

let browser;
let watcher;
try {
  const appPort = await listen(app);
  const refusedPort = await listen(refusedApp);
  const rpcPort = await listen(rpc);
  const allowedOrigin = `http://127.0.0.1:${appPort}`;
  const refusedOrigin = `http://127.0.0.1:${refusedPort}`;
  const signingSeed = randomBytes(32);
  const privateKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), signingSeed,
  ]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKeyText = publicKey.toString('base64url');
  const signingSeedText = signingSeed.toString('base64url');

  process.env.WATCH_ALLOWED_ORIGINS = allowedOrigin;
  process.env.WATCH_TOKEN = 'synthetic-browser-access-token';
  process.env.WATCH_SIGNING_PRIVATE_KEY = signingSeedText;
  process.env.XMR_WALLET_RPC = `http://127.0.0.1:${rpcPort}`;
  const watcherModule = await import(pathToFileURL(path.join(repo, 'scripts/payment-watcher.mjs')));
  watcher = watcherModule.server;
  const watcherPort = await listen(watcher);
  const watcherUrl = `http://127.0.0.1:${watcherPort}/payment?address=8abc&currency=xmr&nonce=AAAAAAAAAAAAAAAAAAAAAA`;
  const { childWatcherToken } = await import(pathToFileURL(path.join(repo, 'src/lib/paymentWatch.js')));
  const childToken = await childWatcherToken(process.env.WATCH_TOKEN, '8abc', 'xmr');

  const deniedPreflights = [];
  watcher.on('request', (request) => {
    if (request.method === 'OPTIONS' && request.headers.origin === refusedOrigin) deniedPreflights.push(request.headers.origin);
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const allowedPage = await context.newPage();
  await allowedPage.goto(allowedOrigin, { waitUntil: 'load' });
  const accepted = await allowedPage.evaluate(async ({ url, token }) => {
    const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'omit', referrerPolicy: 'no-referrer' });
    return { status: response.status, raw: await response.text(), signature: response.headers.get('x-cipher-signature') };
  }, { url: watcherUrl, token: childToken });
  assert.equal(accepted.status, 200);
  assert.ok(accepted.signature, 'browser can read the exposed report-signature header');
  const report = JSON.parse(accepted.raw);
  assert.equal(report.version, 2);
  assert.equal(report.address, '8abc');
  assert.equal(report.currency, 'xmr');
  assert.equal(report.txid, 'synthetic-browser-rpc-tx');
  assert.equal(report.amount, '0.5');
  const trust = await import(pathToFileURL(path.join(repo, 'src/lib/paymentWatcherTrust.js')));
  assert.equal(await trust.verifyPaymentWatcherReport({ rawBody: accepted.raw, signature: accepted.signature,
    publicKey: publicKeyText, expectedNonce: report.nonce }), true);

  const refusedPage = await context.newPage();
  await refusedPage.goto(refusedOrigin, { waitUntil: 'load' });
  const refused = await refusedPage.evaluate(async ({ url, token }) => {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
      return { rejected: false, status: response.status };
    } catch (error) { return { rejected: true, name: error.name }; }
  }, { url: watcherUrl, token: childToken });
  assert.equal(refused.rejected, true, 'the disallowed origin cannot read a report');
  assert.deepEqual(deniedPreflights, [refusedOrigin], 'the watcher refused the browser preflight before GET');
  await context.close();
  console.log('Payment watcher browser-origin test passed: allowed preflight/read/signature and refused origin were exercised against a synthetic local RPC.');
} finally {
  await browser?.close();
  await close(watcher);
  await Promise.all([close(app), close(refusedApp), close(rpc)]);
  fs.rmSync(cleanCwd, { recursive: true, force: true });
}
