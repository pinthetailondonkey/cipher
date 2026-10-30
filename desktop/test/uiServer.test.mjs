import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// Desktop code is CommonJS (electron's main); tests read it without electron.
const require = createRequire(import.meta.url);
const { createUiServer, MIME, CSP } = require('../src/uiServer.js');

function makeFixtureDist() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-ui-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Cipher</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("cipher");\n');
  fs.writeFileSync(path.join(dist, 'assets', 'app.css'), 'body { background: #000 }');
  fs.writeFileSync(path.join(dist, 'icon.svg'), '<svg></svg>');
  fs.writeFileSync(path.join(dist, 'image.webp'), 'fake-webp-bytes');
  return dist;
}

function get(url) {
  return new Promise((resolve, reject) => {
    // plain node http; the fetch global would also do, but this needs no flag
    const { request } = require('node:http');
    const req = request(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the dist index answers with html', async () => {
  const dist = makeFixtureDist();
  const ui = createUiServer(dist, 0);
  await new Promise((r) => ui.listen(r));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    const root = await get(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(root.type, 'text/html');
    assert.match(root.body, /<title>Cipher<\/title>/);
    const named = await get(`${base}/index.html`);
    assert.equal(named.status, 200);
    assert.equal(named.body, root.body);
  } finally {
    ui.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('assets are served with the types vite emits', async () => {
  const dist = makeFixtureDist();
  const ui = createUiServer(dist, 0);
  await new Promise((r) => ui.listen(r));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    for (const [file, type] of [
      ['/assets/app.js', 'text/javascript'],
      ['/assets/app.css', 'text/css'],
      ['/icon.svg', 'image/svg+xml'],
      ['/image.webp', 'image/webp'],
    ]) {
      const res = await get(`${base}${file}`);
      assert.equal(res.status, 200, file);
      assert.equal(res.type, type, file);
      assert.notEqual(res.body, '', file);
    }
  } finally {
    ui.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('paths that resolve out of dist, unknown files and folders all 404', async () => {
  const dist = makeFixtureDist();
  fs.writeFileSync(path.join(path.dirname(dist), 'secret.txt'), 'outside-dist');
  const ui = createUiServer(dist, 0);
  await new Promise((r) => ui.listen(r));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    const cases = [
      '/../secret.txt', // climbs out of dist into the temp dir
      '/..%2Fsecret.txt', // the same climb, url-encoded
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/definitely-not-here.txt',
      '/assets/app.js/extra',
    ];
    for (const p of cases) {
      const res = await get(`${base}${p}`);
      assert.equal(res.status, 404, p);
      assert.equal(res.body, '', p);
    }
    // a folder, not a file, is also 404
    assert.equal((await get(`${base}/assets`)).status, 404);
    // the secret never leaked over the UI server
    assert.equal((await get(`${base}/index.html`)).status, 200); // server still healthy
  } finally {
    ui.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('a pathname that cannot be decoded is refused, not a crash', async () => {
  const dist = makeFixtureDist();
  const ui = createUiServer(dist, 0);
  await new Promise((r) => ui.listen(r));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    const res = await get(`${base}/%zz`);
    assert.equal(res.status, 400);
  } finally {
    ui.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('the mime map is the spike exactly, and unknown types fall back', () => {
  assert.deepEqual(MIME, {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.webp': 'image/webp',
    '.wasm': 'application/wasm',
  });
});

test('a sibling folder that shares the dist prefix is not reachable (defense in depth: normalize already eats the climb)', async () => {
  const dist = makeFixtureDist();
  const sibling = `${dist}-old`;
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'sibling-secret');
  const ui = createUiServer(dist, 0);
  await new Promise((r) => ui.listen(r));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    for (const p of [`/../${path.basename(sibling)}/secret.txt`, `/..%2F${path.basename(sibling)}%2Fsecret.txt`]) {
      const res = await get(`${base}${p}`);
      assert.equal(res.status, 404, p);
      assert.equal(res.body, '', p);
    }
  } finally {
    ui.close();
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test('every answer carries the security headers, errors included', async () => {
  const dist = makeFixtureDist();
  const ui = createUiServer(dist, 0);
  await new Promise((r) => ui.listen(r));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    for (const p of ['/', '/assets/app.js', '/nope.txt', '/%zz']) {
      const res = await get(`${base}${p}`);
      assert.equal(res.headers['content-security-policy'], CSP, p);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', p);
    }
  } finally {
    ui.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('the CSP allows no calls and no framing', () => {
  assert.doesNotMatch(CSP, /stun|turn/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /object-src 'none'/);
  assert.doesNotMatch(CSP, /'unsafe-eval'/);
});
