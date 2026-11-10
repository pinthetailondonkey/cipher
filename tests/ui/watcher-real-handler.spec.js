import { test, expect } from '@playwright/test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childWatcherToken } from '../../src/lib/paymentWatch.js';
import { seedVault, unlock } from './fixtures.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP_ENV_NAMES = [
  'WATCH_TOKEN', 'WATCH_SIGNING_PRIVATE_KEY', 'WATCH_ALLOWED_ORIGINS',
  'XMR_WALLET_RPC', 'BTC_RPC_URL', 'WATCH_PORT', 'PORT', 'WATCH_HOST',
];
const BASE_TOKEN = 'synthetic-browser-operator-token';
const ADDRESS = '8abc';
const AMOUNT = '0.5';
const TXID = 'synthetic-browser-operator-tx';
const PEER = [...schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 2 : 0)))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const encodeEnvValue = (value) => JSON.stringify(String(value));

let tempDir;
let savedCwd;
let savedEnv;
let rpc;
let watcher;
let watcherUrl;
let publicKey;
const watcherRequests = [];
const rpcRequests = [];

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
});

test.beforeAll(async () => {
  savedCwd = process.cwd();
  savedEnv = new Map(TEMP_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of TEMP_ENV_NAMES) delete process.env[name];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-watcher-ui-'));

  const keyOutput = execFileSync(process.execPath, [
    path.join(repo, 'scripts/payment-watcher-keygen.mjs'),
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !TEMP_ENV_NAMES.includes(name))),
  });
  const seed = keyOutput.match(/^WATCH_SIGNING_PRIVATE_KEY=([A-Za-z0-9_-]+)$/m)?.[1];
  publicKey = keyOutput.trim().split(/\r?\n/).at(-1);
  assertKey(seed, publicKey);

  rpc = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const query = JSON.parse(raw);
    rpcRequests.push(query);
    const now = Math.floor(Date.now() / 1000);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { in: [{
      type: 'in', address: ADDRESS, txid: TXID, amount: '500000000000',
      confirmations: 10, timestamp: now, unlock_time: 0,
    }], pool: [] } }));
  });
  const rpcPort = await listen(rpc);
  fs.writeFileSync(path.join(tempDir, '.env'), [
    `WATCH_TOKEN=${BASE_TOKEN}`,
    `WATCH_SIGNING_PRIVATE_KEY=${seed}`,
    `WATCH_ALLOWED_ORIGINS=${encodeEnvValue('http://localhost:8081')}`,
    `XMR_WALLET_RPC=http://127.0.0.1:${rpcPort}`,
    'WATCH_PORT=0',
    '',
  ].join('\n'), { mode: 0o600 });
  process.chdir(tempDir);

  ({ server: watcher } = await import(`${pathToFileURL(path.join(repo, 'scripts/payment-watcher.mjs')).href}?ui-smoke=${Date.now()}`));
  watcher.on('request', (request) => {
    watcherRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || '' });
  });
  const watcherPort = await listen(watcher);
  watcherUrl = `http://127.0.0.1:${watcherPort}/payment?token=${BASE_TOKEN}`;
});

test.afterAll(async () => {
  await close(watcher);
  await close(rpc);
  if (savedCwd) process.chdir(savedCwd);
  for (const [name, value] of savedEnv || []) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function assertKey(seed, key) {
  expect(seed || '').toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(key || '').toMatch(/^[A-Za-z0-9_-]{43}$/);
}

async function prepareOrder(page, { buyerView }) {
  const now = Math.floor(Date.now() / 1000);
  const request = {
    id: 'ord-real-watcher', pubkey: PEER, timestamp: now - 600,
    isSender: buyerView, isGroup: false, chatId: PEER,
    data: {
      type: 'cipher_order', status: 'created', vendorPubkey: PEER,
      product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
      shippingAddress: '12 Made Up Street',
    },
  };
  const acceptance = {
    id: 'acc-real-watcher', pubkey: PEER, timestamp: now - 500,
    isSender: !buyerView, isGroup: false, chatId: PEER,
    data: {
      type: 'order_update', orderId: request.id, status: 'accepted',
      paymentState: 'address_issued', coinCurrency: 'xmr', coinAmount: AMOUNT,
      issuedAt: now - 400, paymentMethods: { xmr: ADDRESS },
    },
  };
  const rows = [request, acceptance];
  await page.addInitScript(seedVault);
  await page.addInitScript(({ url }) => {
    localStorage.setItem('cipher_network', JSON.stringify({ overrides: { explorer: url } }));
  }, { url: watcherUrl });
  await page.goto('/');
  await unlock(page);
  await page.evaluate((key) => {
    const owner = localStorage.getItem('cipher_active_pubkey') || localStorage.getItem('cipher_db_owner');
    if (!owner) throw new Error('No active account for watcher UI smoke.');
    localStorage.setItem(`cipher_${owner}_payment_watcher_signing_key`, JSON.stringify(key));
  }, publicKey);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.evaluate(async ({ peer, messages }) => {
    if (!window.__cipherStore) throw new Error('UI test store seam was not loaded.');
    for (const row of messages) await window.__cipher.saveMessage(peer, row);
    window.__cipherStore.setState({ profiles: { [peer]: { displayName: 'Ada', name: 'ada' } }, dms: { [peer]: messages } });
  }, { peer: PEER, messages: rows });
  await page.getByRole('button', { name: 'Ada' }).click();
  await expect(page.getByRole('button', { name: 'Chat options' })).toBeVisible({ timeout: 10000 });
}

async function receiptSnapshot(page) {
  return page.evaluate(async () => {
    const receipts = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (/_receipt_/.test(key)) receipts.push(key);
    }
    const effects = await window.__cipher.readMessageEffects();
    const rows = Object.values(window.__cipherStore.getState().dms).flat().map((row) => ({
      id: row.id, paymentState: row.data?.paymentState ?? null, patch: row.localPatch ?? null,
    }));
    return { receipts: receipts.sort(), effects, rows };
  });
}

test.use({ serviceWorkers: 'block' });

test.describe('buyer and vendor order checks against the local signed watcher', () => {
  for (const buyerView of [false, true]) {
    test(`${buyerView ? 'buyer' : 'vendor'} confirms from a watcher v2 report`, async ({ page }) => {
      const requestStart = watcherRequests.length;
      const rpcStart = rpcRequests.length;
      await prepareOrder(page, { buyerView });
      await page.getByRole('button', { name: 'Check the chain', exact: true }).first().click();

      await expect(page.getByText('Confirmed', { exact: false }).last()).toBeVisible({ timeout: 20000 });
      if (!buyerView) {
        await expect.poll(async () => (await receiptSnapshot(page)).receipts.length, {
          timeout: 20000, message: 'the vendor confirmation writes a durable receipt',
        }).toBeGreaterThan(0);
      }
      const snapshot = await receiptSnapshot(page);
      if (!buyerView) {
        expect(snapshot.effects).toHaveLength(1);
        expect(snapshot.effects[0].status).toBe('pending'); // no relay acceptance; the outbox retains the update
      }
      const requests = watcherRequests.slice(requestStart);
      const gets = requests.filter((request) => request.method === 'GET');
      expect(gets).toHaveLength(1);
      expect(requests.some((request) => request.method === 'OPTIONS')).toBe(true);
      expect(gets[0].url).not.toContain('token=');
      expect(gets[0].url).not.toContain(BASE_TOKEN);
      expect(gets[0].authorization).toBe(`Bearer ${await childWatcherToken(BASE_TOKEN, ADDRESS, 'xmr')}`);
      expect(rpcRequests.slice(rpcStart)).toEqual([{ jsonrpc: '2.0', id: '0', method: 'get_transfers', params: { in: true, pool: true } }]);
      expect(snapshot.rows.find((row) => row.id === 'acc-real-watcher')).toBeTruthy();
      if (!buyerView) {
        expect(await page.evaluate(() => window.__cipher.readOutboxRows())).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: expect.objectContaining({ kind: 1059 }) }),
        ]));
      }
    });
  }
});
