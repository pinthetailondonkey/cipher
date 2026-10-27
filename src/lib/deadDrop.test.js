import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _deadDropInternals,
  noteUrl,
  noteOrigin,
  createDeadDropNote,
  openDeadDropNote,
  deadDropConsumed,
} from './deadDrop.js';

const { packFragment, unpackFragment, toB64Url, fromB64Url, deriveNoteHash, NOTE_KIND } = _deadDropInternals;
const { entryById } = await import('./egress.js');

// Node 18+ has webcrypto; tests drive the module through it.
if (!globalThis.btoa) {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}
if (!globalThis.atob) {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
// The burn ledger lives in scoped localStorage; the browser fallback
// (absent storage) makes burn a no-op, so tests hand it a fresh one.
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

const b64uToBuf = (t) => Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const { createHash } = await import('node:crypto');

test('fragment round-trips key, iv and hash', () => {
  const key = new Uint8Array(32).fill(1);
  const iv = new Uint8Array(12).fill(2);
  const hash = new Uint8Array(32).fill(3);
  const fragment = packFragment(key, iv, hash);
  const out = unpackFragment(fragment);
  assert.deepEqual(Buffer.from(out.key), Buffer.from(key));
  assert.deepEqual(Buffer.from(out.iv), Buffer.from(iv));
  assert.deepEqual(Buffer.from(out.hash), Buffer.from(hash));
});

test('fragment has no + / or = characters (url-safe)', () => {
  const fragment = packFragment(new Uint8Array(32).fill(7), new Uint8Array(12), new Uint8Array(32));
  assert.doesNotMatch(fragment, /[+/=]/);
});

test('unpackFragment rejects wrong-length fragments', () => {
  assert.equal(unpackFragment(toB64Url(new Uint8Array(10))), null);
  assert.equal(unpackFragment('not-a-fragment!!'), null);
});

test('noteUrl puts payload in the fragment only', () => {
  const origin = noteOrigin() || 'https://notes.example';
  const url = noteUrl('FRAG', origin);
  const [beforeHash, afterHash] = url.split('#');
  assert.ok(afterHash === 'FRAG');
  assert.ok(beforeHash.endsWith('/note'));
  assert.ok(!beforeHash.includes('?'));
});

test('the link host comes from the egress registry', () => {
  const entry = entryById('dead-drop');
  assert.ok(entry, 'dead-drop egress entry exists');
  assert.ok(noteOrigin(), 'noteOrigin resolves');
});

test('note hash is sha256 of the key', async () => {
  const key = new Uint8Array(32).fill(9);
  const hash = await deriveNoteHash(key);
  assert.equal(Buffer.from(hash).toString('hex'), createHash('sha256').update(Buffer.from(key)).digest('hex'));
});

// ————— create / open over a fake pool —————

function fakePool() {
  const published = [];
  return {
    published,
    publish(relays, event) {
      // The real SimplePool returns an array of per-relay promises.
      published.push(event);
      return relays.map(() => Promise.resolve({}));
    },
    async querySync(relays, filter) {
      const want = filter['#d']?.[0];
      return published
        .filter((e) => e.kind === NOTE_KIND && (!want || e.tags.find((t) => t[0] === 'd')?.[1] === want))
        .sort((a, b) => b.created_at - a.created_at);
    },
  };
}

const identity = { sk: new Uint8Array(32).fill(4), pk: '4'.repeat(64) };

test('create then open round-trips the text', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity, text: 'meet at noon', pool, relays });
  assert.ok(hash);
  const fragment = url.split('#')[1];
  assert.ok(fragment);
  // The published event content must not contain the plaintext.
  const blob = pool.published.find((e) => e.kind === NOTE_KIND);
  assert.ok(!Buffer.from(blob.content).toString().includes('noon'));
  const opened = await openDeadDropNote({ identity, fragment, pool, relays });
  assert.equal(opened.text, 'meet at noon');
  assert.equal(opened.hash, hash);
});

test('opening publishes a delete (best-effort destruct)', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url } = await createDeadDropNote({ identity, text: 'burn after read', pool, relays });
  const before = pool.published.length;
  await openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays });
  // The delete is fire-and-forget; give the microtask queue a beat.
  await new Promise((r) => setTimeout(r, 10));
  const del = pool.published[before];
  assert.equal(del.kind, 5);
  assert.equal(del.tags[0][0], 'e');
});

test('a wrong fragment fails closed with the altered-link error', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url } = await createDeadDropNote({ identity, text: 'secret', pool, relays });
  const fragment = url.split('#')[1];
  const b = b64uToBuf(fragment);
  b[0] ^= 0xff; // flip one key bit
  const badFragment = b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await assert.rejects(
    () => openDeadDropNote({ identity, fragment: badFragment, pool, relays }),
    /altered|gone/,
  );
});

test('a missing note fails with a clear error', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  await assert.rejects(
    () => openDeadDropNote({ identity, fragment: packFragment(new Uint8Array(32).fill(5), new Uint8Array(12), new Uint8Array(32).fill(5)), pool, relays }),
    /gone|never/,
  );
});

test('isConsumed blocks re-opening on the same device', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity, text: 'once', pool, relays });
  const consumed = new Set();
  const checker = async (h) => consumed.has(h);
  const first = await openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays, isConsumed: checker });
  assert.equal(first.text, 'once');
  consumed.add(hash);
  await assert.rejects(
    () => openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays, isConsumed: checker }),
    /already opened/,
  );
});

test('the local burn ledger stops the same link opening twice — the app path wires no isConsumed', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity, text: 'burn once', pool, relays });
  const fragment = url.split('#')[1];
  const first = await openDeadDropNote({ identity, fragment, pool, relays });
  assert.equal(first.text, 'burn once');
  assert.equal(deadDropConsumed(hash), true);
  await assert.rejects(
    () => openDeadDropNote({ identity, fragment, pool, relays }),
    /already opened/,
  );
});

test('a failed open does not burn the note — fix the link and it still opens', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url } = await createDeadDropNote({ identity, text: 'recoverable', pool, relays });
  const fragment = url.split('#')[1];
  const b = b64uToBuf(fragment);
  b[0] ^= 0xff; // flip one key bit
  const badFragment = b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await assert.rejects(
    () => openDeadDropNote({ identity, fragment: badFragment, pool, relays }),
    /altered|gone/,
  );
  const opened = await openDeadDropNote({ identity, fragment, pool, relays });
  assert.equal(opened.text, 'recoverable');
});

test('oversized notes are refused at create', async () => {
  const pool = fakePool();
  await assert.rejects(
    () => createDeadDropNote({ identity, text: 'x'.repeat(8001), pool, relays: [] }),
    /too long/,
  );
});
