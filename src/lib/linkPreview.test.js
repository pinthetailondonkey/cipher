import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLinkPreview, firstUrl } from './linkPreview.js';
import { setPrivacy, getPrivacy } from './privacy.js';
import { scopeKey } from './storage.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  key: (index) => Array.from(memory.keys())[index] || null,
  get length() { return memory.size; },
};

test('a fresh profile makes no preview request — the default is off', async () => {
  localStorage.setItem('cipher_active_pubkey', 'ab'.repeat(32));
  localStorage.removeItem(scopeKey('privacy'));
  assert.equal(getPrivacy().linkPreviews, false, 'the default must be off');
  let calls = 0;
  const spy = async () => { calls += 1; throw new Error('the preview host must not be asked'); };
  const result = await fetchLinkPreview('https://example.com/page', { fetchImpl: spy });
  assert.equal(result, null);
  assert.equal(calls, 0, 'no request may leave the device with defaults');
});

test('an opted-in profile asks the preview host exactly once', async () => {
  setPrivacy({ linkPreviews: true });
  const asked = [];
  const fake = async (endpoint) => {
    asked.push(endpoint);
    return { ok: true, json: async () => ({ data: { title: 'T', description: 'D', image: { url: 'https://img.example/x.png' } } }) };
  };
  const meta = await fetchLinkPreview('https://example.com/page', { fetchImpl: fake });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /url=https%3A%2F%2Fexample\.com%2Fpage$/, 'the target rides the query, encoded');
  assert.deepEqual(meta, { title: 'T', description: 'D', image: 'https://img.example/x.png' });
  setPrivacy({ linkPreviews: false });
});

test('a refused or broken response stays a null preview, never a throw', async () => {
  setPrivacy({ linkPreviews: true });
  const refused = await fetchLinkPreview('https://example.com/no', { fetchImpl: async () => ({ ok: false }) });
  assert.equal(refused, null);
  const broken = await fetchLinkPreview('https://example.com/x', { fetchImpl: async () => { throw new Error('network gone'); } });
  assert.equal(broken, null);
  setPrivacy({ linkPreviews: false });
});

test('firstUrl picks the first link and trims trailing punctuation', () => {
  assert.equal(firstUrl('see https://example.com/a.'), 'https://example.com/a');
  assert.equal(firstUrl('no links here'), '');
  assert.equal(firstUrl(''), '');
});
