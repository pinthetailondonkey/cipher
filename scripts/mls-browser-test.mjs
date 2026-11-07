import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = 8092;
const origin = `http://127.0.0.1:${port}`;
const wasmDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../crypto/mls-eval/target/browser-bindings');
const assets = new Map([
  ['/mls/cipher_mls_eval.js', ['cipher_mls_eval.js', 'text/javascript; charset=utf-8']],
  ['/mls/cipher_mls_eval_bg.wasm', ['cipher_mls_eval_bg.wasm', 'application/wasm']],
]);
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>OpenMLS WASM evaluation</title></head><body>Ready</body></html>');
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

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const mls = await import('/mls/cipher_mls_eval.js');
    await mls.default();
    if (!mls.private_add_commit_and_removal_flow()) throw new Error('The OpenMLS member add/remove flow returned false.');
    return { implementation: 'openmls-0.9.2', browserRuntime: true, removedMemberRejected: true };
  });
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(`OpenMLS WASM browser integration passed: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
