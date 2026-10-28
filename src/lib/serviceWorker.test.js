import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// public/sw.js is a classic worker, so it is run here in a sandbox with a
// stand-in `self`, `caches` and `fetch`, and the fetch handler is driven by hand.
const SW = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'public', 'sw.js');

function load(fetchImpl) {
  const stored = new Map();
  const listeners = {};
  const caches = {
    match: async (key) => stored.get(typeof key === 'string' ? key : key.url),
    open: async () => ({
      put: async (key, response) => { stored.set(typeof key === 'string' ? key : key.url, response); },
      addAll: async () => {},
    }),
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    location: new URL('https://app.example/'),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(fs.readFileSync(SW, 'utf8'), { self, caches, fetch: fetchImpl, URL, console });
  return { stored, listeners };
}

async function ask(listeners, request) {
  let answer;
  listeners.fetch({ request, respondWith: (promise) => { answer = promise; } });
  return answer;
}

const reply = (type, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
  clone() { return this; },
});
const get = (pathname, destination) => ({ method: 'GET', mode: 'cors', destination, url: `https://app.example${pathname}` });

test('a missing hashed script that comes back as the SPA fallback is not cached', async () => {
  const { stored, listeners } = load(async () => reply('text/html; charset=utf-8'));
  await ask(listeners, get('/assets/index-OLDHASH.js', 'script'));
  assert.equal(stored.size, 0);
});

test('a script answered with a non-script type is not cached', async () => {
  const { stored, listeners } = load(async () => reply('application/octet-stream'));
  await ask(listeners, get('/assets/index-abc.js', 'script'));
  assert.equal(stored.size, 0);
});

test('a stylesheet answered with html is not cached', async () => {
  const { stored, listeners } = load(async () => reply('text/html'));
  await ask(listeners, get('/assets/index-abc.css', 'style'));
  assert.equal(stored.size, 0);
});

test('a real script and a real stylesheet are cached', async () => {
  const js = load(async () => reply('text/javascript'));
  await ask(js.listeners, get('/assets/index-abc.js', 'script'));
  assert.equal(js.stored.size, 1);
  const css = load(async () => reply('text/css'));
  await ask(css.listeners, get('/assets/index-abc.css', 'style'));
  assert.equal(css.stored.size, 1);
});

test('a font under /assets is cached, an error status never is', async () => {
  const font = load(async () => reply('font/woff2'));
  await ask(font.listeners, get('/assets/archivo-abc.woff2', 'font'));
  assert.equal(font.stored.size, 1);
  const gone = load(async () => reply('text/javascript', 404));
  await ask(gone.listeners, get('/assets/index-abc.js', 'script'));
  assert.equal(gone.stored.size, 0);
});
