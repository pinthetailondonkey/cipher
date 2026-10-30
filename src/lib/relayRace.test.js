import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEALTH_KEY,
  REFUSED_COOLDOWN_MS,
  SHORT_LEASH_MS,
  SLOW_MS,
  firstAnswer,
  gradeOf,
  noteAnswer,
  orderByHealth,
  patienceFor,
  readHealth,
  writeHealth,
} from './relayRace.js';

const ev = (id) => ({ id, kind: 4 });
const wait = (ms, value) => () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const memory = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
};

test('the first relay with something to show ends the stage, not the slowest one', async () => {
  const started = Date.now();
  const events = await firstAnswer([wait(5, [ev('fast')]), wait(1500, [ev('slow')])], { timeoutMs: 2500 });
  const took = Date.now() - started;
  assert.deepEqual(events.map((e) => e.id), ['fast']);
  assert.ok(took < 900, `should not wait for the slow relay, took ${took}ms`);
});

test('the grace is short: a relay that answers inside it is merged, one that does not is not', async () => {
  const merged = await firstAnswer([wait(5, [ev('first')]), wait(60, [ev('near')])], { timeoutMs: 2000 });
  assert.deepEqual(merged.map((e) => e.id).sort(), ['first', 'near']);
  const alone = await firstAnswer([wait(5, [ev('first')]), wait(700, [ev('far')])], { timeoutMs: 2000 });
  assert.deepEqual(alone.map((e) => e.id), ['first']);
});

test('an empty answer never wins: it says nothing about what the others hold', async () => {
  const events = await firstAnswer([wait(1, []), wait(30, [ev('other')])], { timeoutMs: 1000 });
  assert.deepEqual(events.map((e) => e.id), ['other']);
});

test('every relay empty ends the stage as soon as the last one answers', async () => {
  const started = Date.now();
  const events = await firstAnswer([wait(5, []), wait(10, [])], { timeoutMs: 2000 });
  const took = Date.now() - started;
  assert.deepEqual(events, []);
  assert.ok(took < 500, `empty is an answer too, took ${took}ms`);
});

test('a hanging relay is dropped at the cap and the answers that arrived are kept', async () => {
  const started = Date.now();
  const events = await firstAnswer([() => new Promise(() => {}), wait(1, [])], { timeoutMs: 120 });
  const took = Date.now() - started;
  assert.deepEqual(events, []);
  assert.ok(took >= 100 && took < 900, `cap should decide, took ${took}ms`);
});

test('answers that arrive together are merged, never truncated to one relay', async () => {
  const events = await firstAnswer([wait(10, [ev('a')]), wait(12, [ev('b')])], { timeoutMs: 1000 });
  assert.deepEqual(events.map((e) => e.id).sort(), ['a', 'b']);
});

test('a relay that throws counts as an empty answer, not a failed stage', async () => {
  const events = await firstAnswer([() => Promise.reject(new Error('refused')), wait(5, [ev('ok')])], { timeoutMs: 1000 });
  assert.deepEqual(events.map((e) => e.id), ['ok']);
});

test('no attempts and non-function entries are answered, never left hanging', async () => {
  assert.deepEqual(await firstAnswer([], { timeoutMs: 50 }), []);
  assert.deepEqual(await firstAnswer([null, 'no'], { timeoutMs: 50 }), []);
});

test('a relay that answered fast keeps its place; slow and refused go last', () => {
  const now = 1_000_000;
  const health = {
    'wss://slow': { result: 'slow', at: now, ms: 3000 },
    'wss://ok': { result: 'ok', at: now, ms: 120 },
    'wss://refused': { result: 'refused', at: now },
  };
  assert.deepEqual(
    orderByHealth(['wss://slow', 'wss://unknown', 'wss://refused', 'wss://ok'], health, now),
    ['wss://ok', 'wss://unknown', 'wss://slow', 'wss://refused'],
  );
});

test('a refused relay is retried after the cooldown instead of being written off for ever', () => {
  const now = 1_000_000;
  const health = { 'wss://refused': { result: 'refused', at: now } };
  assert.equal(gradeOf(health['wss://refused'], now), 'bad');
  assert.equal(gradeOf(health['wss://refused'], now + REFUSED_COOLDOWN_MS + 1), 'unknown');
});

test('a bad relay gets a short leash and a good one the whole cap', () => {
  const now = 1_000_000;
  const health = {
    'wss://refused': { result: 'refused', at: now },
    'wss://slow': { result: 'slow', at: now },
    'wss://ok': { result: 'ok', at: now },
  };
  assert.equal(patienceFor('wss://refused', health, 4000, now), SHORT_LEASH_MS);
  assert.equal(patienceFor('wss://slow', health, 4000, now), SLOW_MS);
  assert.equal(patienceFor('wss://ok', health, 4000, now), 4000);
  assert.equal(patienceFor('wss://never-seen', health, 4000, now), 4000);
});

test('a grade is written from what happened, and never mutates the record it came from', () => {
  const now = 1_000_000;
  const before = { 'wss://a': { result: 'ok', at: now - 5 } };
  const after = noteAnswer(before, 'wss://a', { ms: 3500, empty: true }, now);
  assert.equal(after['wss://a'].result, 'slow');
  assert.equal(before['wss://a'].result, 'ok');
  assert.equal(noteAnswer(before, 'wss://b', { ok: false }, now)['wss://b'].result, 'refused');
  assert.equal(noteAnswer(before, 'wss://c', { ms: 40 }, now)['wss://c'].result, 'ok');
});

test('health survives a round trip and a corrupt entry reads as no opinion', () => {
  const store = memory();
  const health = noteAnswer({}, 'wss://a', { ms: 50 }, 123);
  writeHealth(health, store);
  assert.deepEqual(readHealth(store), health);
  assert.equal(store.getItem(HEALTH_KEY) !== null, true);
  store.setItem(HEALTH_KEY, '{not json');
  assert.deepEqual(readHealth(store), {});
  store.setItem(HEALTH_KEY, '["an array"]');
  assert.deepEqual(readHealth(store), {});
  assert.deepEqual(readHealth({ getItem: () => { throw new Error('denied'); } }), {});
});
