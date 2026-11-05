import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberGatewayPubkey, storedGatewayPubkey, gatewayEntryUrl } from './pushGatewayStore.js';

// The store reads localStorage through src/lib/storage's scoped getters; in
// Node there is none, so a stub stands in and the cache starts empty.
test('the gateway wrap pubkey is stored only when it is shaped like one', () => {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
    key: (index) => Array.from(backing.keys())[index] ?? null,
    get length() { return backing.size; },
  };
  rememberGatewayPubkey('https://push.example', 'aa'.repeat(32));
  assert.equal(storedGatewayPubkey(), 'aa'.repeat(32));
  assert.equal(gatewayEntryUrl(), 'https://push.example');
  // A malformed value never overwrites the good one.
  rememberGatewayPubkey('https://push.example', 'not-a-key');
  assert.equal(storedGatewayPubkey(), 'aa'.repeat(32));
  delete globalThis.localStorage;
});
