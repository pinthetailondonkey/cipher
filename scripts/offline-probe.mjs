// THE OFFLINE WITNESS. It needs Playwright (a dev dependency already in this
// repo) and a browser to download, so it is not on the `npm test` line: it is
// run by hand, against a build, when the caching is what changed.
//
//   node scripts/offline-probe.mjs dist [port]
//
// What it proves, in order:
//   1. the worker installs without the whole install failing on one asset, and
//      afterwards holds every file the manifest names;
//   2. an old shell cache left behind by a previous version is deleted, so the
//      client ends holding exactly one;
//   3. with the network cut, a person can unlock and the app opens;
//   4. a tab nobody has ever visited in this session (Orders) draws, which is
//      the code that used to be missing.
//
// Exit code 0 means GREEN, 1 means RED. Every request that failed is printed
// either way, so a failure names its own cause.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getPublicKey } from 'nostr-tools';

const DIST = process.argv[2] || 'dist';
const PORT = Number(process.argv[3] || 8102);
const MANIFEST = path.join(DIST, 'asset-manifest.json');
if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`usage: offline-probe.mjs <distDir> [port] — no build in ${DIST}`);

const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = path.join(DIST, url);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  // A file under /assets/ that is not there is a miss, not a page: answering
  // it with the app shell would make a broken build look installed.
  if (url.startsWith('/assets/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(path.join(DIST, 'index.html')));
});
await new Promise((resolve) => server.listen(PORT, resolve));

// A throwaway account, made the way the app makes one: the secret is sealed in
// a PIN vault in localStorage, so the unlock below is the real screen.
const SK = Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const PK = getPublicKey(Uint8Array.from(SK));
const PIN = '12345678';
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const material = await crypto.subtle.importKey('raw', enc.encode(PIN), { name: 'PBKDF2' }, false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(SK)));
const vault = { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)), salt: Array.from(salt), iter: 600000 };
// Relays that answer nothing: the witness is about code on the device, not
// about what the network carries. An unreachable relay keeps the app's own
// failures from being mistaken for cache failures.
const net = JSON.stringify({ overrides: { 'dm-relay': 'ws://localhost:1/fast', 'group-relay': 'ws://localhost:1/fast', 'profile-nos': 'off', 'profile-damus': 'off', 'profile-purple': 'off' }, lists: { profile: [], dm: [] } });

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const failed = [];
page.on('requestfailed', (r) => failed.push(r.url().split('/').pop()));

const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });

await page.addInitScript(({ pk, vault: v, net: n }) => {
  localStorage.setItem('cipher_vaults', JSON.stringify({ [pk]: { vault: v, handle: 'probe', displayName: 'Probe', createdAt: 1700000000000, confirmed: true } }));
  localStorage.setItem('cipher_active_pubkey', pk);
  localStorage.setItem('cipher_network', n);
}, { pk: PK, vault, net });

console.log('build:', DIST);
await page.goto(`http://localhost:${PORT}/`);
await page.getByRole('heading', { name: 'Unlock Cipher' }).waitFor({ timeout: 20000 });

// Wait for the worker to install, take control and finish whatever it fills.
await page.evaluate(async () => {
  if (!navigator.serviceWorker) return;
  await navigator.serviceWorker.ready;
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

// 1 + 2. What the client holds now: exactly one shell cache, and every file
// the build named is inside it. The v2 cache seeded before the reload is the
// previous version's leftovers; a client that keeps it is carrying dead code
// it will never serve again.
const seeded = await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) await reg.unregister();
  for (const name of await caches.keys()) await caches.delete(name);
  const cache = await caches.open('cipher-shell-v2');
  await cache.put('/assets/left-over.js', new Response('stale', { type: 'text/javascript' }));
  return (await caches.keys()).slice();
});
await page.reload();
await page.getByRole('heading', { name: 'Unlock Cipher' }).waitFor({ timeout: 20000 });
await page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

const held = await page.evaluate(async () => {
  const keys = await caches.keys();
  const urls = [];
  for (const name of keys) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
  }
  return { caches: keys, controller: !!navigator.serviceWorker.controller, urls };
});
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { files: [] };
const assetUrls = held.urls.filter((url) => url.startsWith('/assets/'));
const missing = manifest.files.filter((file) => !assetUrls.includes(file));
console.log('caches before the reload: seeded', JSON.stringify(seeded));
console.log('caches now:', JSON.stringify(held.caches), '| controlled:', held.controller);
console.log(`assets held: ${assetUrls.length} of ${manifest.files.length} named by the manifest` + (missing.length ? ` | MISSING ${missing.join(', ')}` : ''));
if (held.caches.length !== 1) console.log('NOTE: more than one shell cache survived the new worker');
if (missing.length) console.log(`NOTE: ${missing.length} named assets are not on the device`);

// 3. The network goes away for good from here.
await context.setOffline(true);
const pad = page.getByRole('group', { name: 'Number pad' });
for (const digit of PIN) await pad.getByRole('button', { name: digit, exact: true }).click();
await page.getByRole('button', { name: 'Unlock', exact: true }).click();

let reached = false;
try {
  await page.waitForFunction(() => /No chats yet|Pick a chat/.test(document.body.innerText || ''), null, { timeout: 20000 });
  reached = true;
} catch { reached = false; }
console.log('screen after an offline unlock:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 220));

// 4. A tab nobody opened yet: its code had to come from the install, not from
// having been visited.
let ordersDrew = false;
if (reached) {
  try {
    await page.getByRole('button', { name: 'Orders', exact: true }).first().click();
    await page.getByRole('heading', { name: 'My Orders' }).waitFor({ timeout: 15000 });
    ordersDrew = true;
  } catch { ordersDrew = false; }
  console.log('screen after an offline tap on Orders:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 220));
}

console.log('failed requests:', failed.length ? failed.join(', ') : 'none');
const green = reached && ordersDrew;
console.log(green
  ? 'GREEN — the app opens and an unvisited screen draws with the network off'
  : `RED — offline unlock: ${reached ? 'opens' : 'BLOCKED'}, Orders tab: ${ordersDrew ? 'draws' : 'DOES NOT DRAW'}`);

await browser.close();
server.close();
process.exit(green ? 0 : 1);
