import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const html = path.join(dist, 'protocol-test.html');
if (!existsSync(html)) throw new Error('Build the dedicated protocol test artifact first with build:protocol-test.');
if (existsSync(path.join(dist, 'index.html'))) throw new Error('Protocol test artifact contains the ordinary app entry.');
if (existsSync(path.join(dist, 'sw.js')) || existsSync(path.join(dist, 'manifest.json')))
  throw new Error('Protocol test artifact contains production PWA assets.');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
]);
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? '/protocol-test.html' : pathname;
  const file = path.resolve(dist, `.${relative}`);
  if (!file.startsWith(`${dist}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.setHeader('content-type', mime.get(path.extname(file)) || 'application/octet-stream');
  response.setHeader('cache-control', 'no-store');
  createReadStream(file).pipe(response);
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const externalRequests = [];
  const webSockets = [];
  await context.route('**/*', async (route) => {
    const requestOrigin = new URL(route.request().url()).origin;
    if (requestOrigin !== origin) {
      externalRequests.push(route.request().url());
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('websocket', (socket) => webSockets.push(socket.url()));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Experimental protocol tests' }).waitFor();
  assert.match(await page.locator('body').innerText(), /test build/i);
  assert.match(await page.locator('body').innerText(), /Only configured local relay addresses can be used/);
  assert.match(await page.locator('body').innerText(), /Double Ratchet DM: disabled/);
  assert.match(await page.locator('body').innerText(), /MLS groups: disabled/);
  assert.match(await page.locator('body').innerText(), /ws:\/\/127\.0\.0\.1:18888/);

  await page.getByRole('button', { name: 'Start test mode' }).click();
  await page.getByRole('heading', { name: 'Disposable test identity' }).waitFor();
  const started = await page.evaluate(async () => ({
    localStorageKeys: Object.keys(localStorage),
    databases: await indexedDB.databases(),
    body: document.body.innerText,
  }));
  const testDatabases = started.databases.map((item) => item.name).filter((name) => name?.startsWith('CipherProtocolTest_v1_'));
  assert.equal(testDatabases.length, 1, 'test mode must create one isolated test database');
  assert.equal(started.databases.some((item) => item.name?.startsWith('CipherDB_v7_')), false,
    'test mode must not open an account database');
  assert.equal(started.localStorageKeys.includes('cipher_db_owner'), false,
    'test mode must not set the production account database owner');
  assert.match(started.body, /Identity: [0-9a-f]{64}/);
  assert.match(started.body, /Test device: [0-9a-f]{64}/);

  await page.getByRole('button', { name: 'Disable test mode' }).click();
  await page.getByText('Test mode is off. The run is held for review or explicit deletion.').waitFor();
  const held = await page.evaluate(() => indexedDB.databases());
  assert.equal(held.some((item) => item.name === testDatabases[0]), true, 'disable must hold the isolated test state');

  await page.getByRole('button', { name: 'Delete this test run' }).click();
  await page.getByText('This disposable test run was deleted.').waitFor();
  const afterDelete = await page.evaluate(() => indexedDB.databases());
  assert.equal(afterDelete.some((item) => item.name === testDatabases[0]), false,
    'explicit test-run cleanup must remove only the isolated test database');
  assert.deepEqual(externalRequests, [], 'the protocol test app requested a non-local origin');
  assert.deepEqual(webSockets, [], 'the scaffold must not open a relay connection before protocol integration');
  await context.close();
  process.stdout.write('Protocol test-mode browser harness passed: isolated disposable identity/device, local-only page, stop-and-hold, and explicit cleanup. No relay messages are implemented yet.\n');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
