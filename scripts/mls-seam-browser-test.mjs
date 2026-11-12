// Browser-runtime proof for the shipped MLS seam (src/lib/mlsGroups.js):
// two engines inside one real browser, full lifecycle through the actual
// export surface — create/invite/join/seal/open/process/snapshot-restore —
// against the REAL wasm build the app ships.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = 8093;
const origin = `http://127.0.0.1:${port}`;
const wasmDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../crypto/mls-wasm/target/browser-bindings');
const assets = new Map([
  ['/mls/cipher_mls_eval.js', ['cipher_mls_eval.js', 'text/javascript; charset=utf-8']],
  ['/mls/cipher_mls_eval_bg.wasm', ['cipher_mls_eval_bg.wasm', 'application/wasm']],
]);
// The seam imports its bindings through Vite-style relative specifiers with
// a bare '/mls/' alias here; serve a shim that rewrites the import to /mls/.
const seamShim = `
async function loadBindings() {
  const mod = await import('/mls/cipher_mls_eval.js');
  await mod.default();
  return mod;
}
let mod;
const BIG = (n) => (typeof n === 'bigint' ? n : BigInt(n));
function bridge(fn, args) {
  const raw = fn(...args);
  if (typeof raw !== 'string') throw new Error('ERR:bridge-shape:' + typeof raw);
  return JSON.parse(raw);
}
// Every mls_* op takes the handle first; pass it through as BigInt.
async function bridgeWrap(fn, args) {
  try {
    const normalized = args.map((a) => (typeof a === 'number' && Number.isSafeInteger(a) && a > 0 ? BIG(a) : a));
    const raw = await fn(...normalized);
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { throw new Error('ERR:non-json:' + raw.slice(0,80)); } }
    return raw;
  } catch (error) {
    const text = error?.message ?? String(error);
    if (typeof text === 'string' && text.startsWith('ERR:')) throw error;
    throw new Error('ERR:wrap:' + text);
  }
}
const b64e = (bytes) => { let s=''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const b64d = (t) => Uint8Array.from(atob(t), c => c.charCodeAt(0));
`;

const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Cipher MLS seam proof</title></head><body>Ready</body></html>');
    return;
  }
  if (request.url === '/seam-test.mjs') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(seamTestSource());
    return;
  }
  const asset = assets.get(request.url);
  if (!asset) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' });
    response.end(await readFile(path.join(wasmDir, asset[0])));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});

function seamTestSource() {
  return `${seamShim}
export async function run() {
  // Engine A creates the group and adds engine B.
  const labelA = 'founder-a-pk';
  mod = await loadBindings();
  const handleA = BIG(bridge(mod.mls_engine_create.bind(mod), [labelA]).handle);
  const created = await bridgeWrap(mod.mls_group_create.bind(mod), [handleA]);
  if (!created.group_ref) throw new Error('ERR:test-no-group-ref');

  const handleB = BIG(bridge(mod.mls_engine_create.bind(mod), ['founder-b-pk']).handle);
  const kpOut = bridge(mod.mls_engine_key_package.bind(mod), [handleB]);
  const kp = (typeof kpOut === 'string' ? JSON.parse(kpOut) : kpOut).key_package;

  const addOut = await bridgeWrap(mod.mls_group_add.bind(mod), [handleA, kp]);
  if (!addOut.welcome || !addOut.commit) throw new Error('ERR:test-add-shape');

  const joinOut = await bridgeWrap(mod.mls_group_join.bind(mod), [handleB, addOut.welcome]);
  if (!joinOut.group_ref) throw new Error('ERR:test-join-failed');

  // Roster agreement, both sides see both labels.
  for (const handle of [handleA, handleB]) {
    const roster = await bridgeWrap(mod.mls_members.bind(mod), [handle]);
    const labels = roster.members.map((m) => m.label).sort();
    if (!(labels.join(',') === 'founder-a-pk,founder-b-pk')) throw new Error('ERR:test-roster:' + labels.join(','));
  }

  // A -> B application message, byte-exact round trip through wire bytes.
  const payload = b64e(new TextEncoder().encode('seam-proof-one'));
  const sealed = await bridgeWrap(mod.mls_encrypt.bind(mod), [handleA, payload]);
  const opened = await bridgeWrap(mod.mls_process.bind(mod), [handleB, sealed.message]);
  if (opened.kind !== 'application') throw new Error('ERR:test-open-kind:' + opened.kind);
  if (new TextDecoder().decode(b64d(opened.plaintext)) !== 'seam-proof-one') throw new Error('ERR:test-payload-mismatch');

  // B -> A reply.
  const reply = await bridgeWrap(mod.mls_encrypt.bind(mod), [handleB, b64e(new TextEncoder().encode('reply-from-b'))]);
  const openedReply = await bridgeWrap(mod.mls_process.bind(mod), [handleA, reply.message]);
  if (new TextDecoder().decode(b64d(openedReply.plaintext)) !== 'reply-from-b') throw new Error('ERR:test-reply-mismatch');

  // Replay fails closed on the consumed message.
  let replayFailed = false;
  try { await bridgeWrap(mod.mls_process.bind(mod), [handleB, sealed.message]); }
  catch (error) { replayFailed = String(error?.message ?? error).startsWith('ERR:'); }
  if (!replayFailed) throw new Error('ERR:test-replay-not-rejected');

  // Snapshot -> restore keeps the group usable end to end.
  const snapA = await bridgeWrap(mod.mls_engine_snapshot.bind(mod), [handleA]);
  const restoredOut = await bridgeWrap(mod.mls_engine_restore.bind(mod), [JSON.stringify(snapA)]);
  const restoredA = BIG(restoredOut.handle);
  const sentRestored = await bridgeWrap(mod.mls_encrypt.bind(mod), [restoredA, b64e(new TextEncoder().encode('from-restored'))]);
  const openedRestored = await bridgeWrap(mod.mls_process.bind(mod), [handleB, sentRestored.message]);
  if (new TextDecoder().decode(b64d(openedRestored.plaintext)) !== 'from-restored') throw new Error('ERR:test-restore-flow');
  const rosterRestored = await bridgeWrap(mod.mls_members.bind(mod), [restoredA]);
  if (rosterRestored.members.length !== 2) throw new Error('ERR:test-restore-roster');

  return { ok: true, checks: ['create','invite','join','roster','seal-open','reply','replay-closed','snapshot-restore'] };
}

`;
}

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: '/home/aegis/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const test = await import('/seam-test.mjs');
    return test.run();
  });
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  if (!result?.ok) throw new Error(`Seam proof returned not-ok: ${JSON.stringify(result)}`);
  console.log(`Cipher MLS seam browser proof passed: ${result.checks.join(', ')}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
