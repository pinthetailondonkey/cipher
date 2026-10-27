import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node has no localStorage; the module persists to it lazily on first write.
if (!globalThis.localStorage) {
  let backing = {};
  globalThis.localStorage = {
    getItem: (k) => (k in backing ? backing[k] : null),
    setItem: (k, v) => { backing[k] = String(v); },
    removeItem: (k) => { delete backing[k]; },
    clear: () => { backing = {}; },
  };
}

import {
  deriveSafetyNumber,
  noteFirstSeen,
  markSafetyChange,
  verifySafetyNumber,
  safetyNumberFor,
  safetyRecord,
  _safetyInternals,
} from './safetyNumber.js';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const RELAYS = ['wss://relay.one/', 'wss://relay.two'];
const NOW = 1700000000;

test('deriveSafetyNumber is 5 groups of 3 digits, space-separated', () => {
  const n = deriveSafetyNumber(PK_A, RELAYS);
  assert.match(n, /^\d{3} \d{3} \d{3} \d{3} \d{3}$/);
});

test('deriveSafetyNumber is deterministic and input-sensitive', () => {
  const a = deriveSafetyNumber(PK_A, RELAYS);
  const a2 = deriveSafetyNumber(PK_A, RELAYS);
  const b = deriveSafetyNumber(PK_B, RELAYS);
  const relayChanged = deriveSafetyNumber(PK_A, ['wss://relay.three']);
  assert.equal(a, a2);
  assert.notEqual(a, b);
  assert.notEqual(a, relayChanged);
});

test('relay canonicalization ignores scheme, trailing slash, case', () => {
  const { canonicalRelays } = _safetyInternals;
  assert.deepEqual(canonicalRelays(['WSS://Relay.One/', 'relay.two']), canonicalRelays(['wss://relay.one', 'wss://relay.two/']));
  assert.deepEqual(canonicalRelays(['wss://relay.one', 'wss://relay.one']), ['relay.one']);
});

test('noteFirstSeen freezes the first record and never moves it', async () => {
  localStorage.clear();
  const first = await noteFirstSeen(PK_A, RELAYS, NOW);
  assert.equal(first.firstSeenAt, NOW);
  assert.deepEqual(first.relays, ['relay.one', 'relay.two']);
  assert.equal(first.changed, false);
  // A later call with a different relay set must NOT move first-seen.
  const later = await noteFirstSeen(PK_A, ['wss://evil.relay'], NOW + 5000);
  assert.equal(later.firstSeenAt, NOW);
  assert.deepEqual(later.relays, ['relay.one', 'relay.two']);
});

test('safetyNumberFor returns the readable surface, null before first contact', async () => {
  localStorage.clear();
  assert.equal(safetyNumberFor(PK_B), null);
  await noteFirstSeen(PK_B, RELAYS, NOW);
  const view = safetyNumberFor(PK_B);
  assert.equal(view.number, deriveSafetyNumber(PK_B, RELAYS));
  assert.equal(view.changed, false);
  assert.equal(view.firstSeenAt, NOW);
});

test('markSafetyChange flips the changed flag, number stays pinned', async () => {
  localStorage.clear();
  await noteFirstSeen(PK_A, RELAYS, NOW);
  const before = safetyNumberFor(PK_A);
  const after = markSafetyChange(PK_A);
  assert.equal(after.changed, true);
  assert.equal(safetyNumberFor(PK_A).number, before.number);
  assert.equal(safetyRecord(PK_A).firstSeenAt, NOW);
});

test('markSafetyChange on an unknown contact is a no-op null', () => {
  localStorage.clear();
  assert.equal(markSafetyChange(PK_B), null);
});

test('verifySafetyNumber clears the changed flag, code stays pinned', async () => {
  localStorage.clear();
  await noteFirstSeen(PK_A, RELAYS, NOW);
  markSafetyChange(PK_A);
  const after = verifySafetyNumber(PK_A);
  assert.equal(after.changed, false);
  // The code never moves with the flag: it is pinned to first-seen.
  assert.equal(safetyNumberFor(PK_A).number, deriveSafetyNumber(PK_A, RELAYS));
  assert.equal(safetyRecord(PK_A).firstSeenAt, NOW);
});

test('verifySafetyNumber on an unknown contact is a no-op null', () => {
  localStorage.clear();
  assert.equal(verifySafetyNumber(PK_B), null);
});
