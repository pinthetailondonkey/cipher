import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  _deadDropInternals,
  noteUrl,
  noteOrigin,
  createDeadDropNote,
  openDeadDropNote,
  deadDropConsumed,
  createCarrierNote,
  openCarrierNote,
  createNoteLink,
  carrierAvailable,
  forgetCarrierProbe,
  isCarrierFragment,
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
  // The host has to serve a page that opens a note. The app host does: the
  // app parses path /note and reads the key from the fragment.
  assert.equal(entry.url, entryById('app-host').url);
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

// ————— hold: the vendor's delivery carrier —————

test('hold returns the text, burns nothing yet, and burn completes the one-open promise', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity, text: 'address inside', pool, relays });
  const before = pool.published.length;
  const opened = await openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays, hold: true });
  assert.equal(opened.text, 'address inside');
  assert.equal(opened.hash, hash);
  assert.equal(typeof opened.burn, 'function');
  // Held open: no local burn, no delete request.
  assert.equal(deadDropConsumed(hash), false);
  assert.equal(pool.published.length, before);
  // A second hold on the same device still opens — nothing was spent.
  const again = await openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays, hold: true });
  assert.equal(again.text, 'address inside');
  // Save happened; burn now spends it.
  await opened.burn();
  assert.equal(deadDropConsumed(hash), true);
  await assert.rejects(
    () => openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays }),
    /already opened/,
  );
});

test('held-open and discarded leaves the note as it was — a failed save can retry', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity, text: 'survives the failed save', pool, relays });
  await openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays, hold: true });
  assert.equal(deadDropConsumed(hash), false);
  const later = await openDeadDropNote({ identity, fragment: url.split('#')[1], pool, relays, hold: true });
  await later.burn();
  await new Promise((r) => setTimeout(r, 10));
  const del = pool.published.find((e) => e.kind === 5);
  assert.ok(del, 'the burn still publishes the delete request');
});

// ————— a stranger cannot shadow or poison a note —————

const { finalizeEvent, getPublicKey } = await import('nostr-tools');
const buyerSk = new Uint8Array(32).fill(7);
const vendorSk = new Uint8Array(32).fill(8);
const attackerSk = new Uint8Array(32).fill(9);
const buyer = { sk: buyerSk, pk: getPublicKey(buyerSk) };
const vendor = { sk: vendorSk, pk: getPublicKey(vendorSk) };

// Honors the authors filter like a relay does, and records every filter.
function filteringPool() {
  const pool = fakePool();
  pool.filters = [];
  const base = pool.querySync;
  pool.querySync = async (relays, filter) => {
    pool.filters.push(filter);
    const rows = await base(relays, filter);
    return filter.authors ? rows.filter((e) => filter.authors.includes(e.pubkey)) : rows;
  };
  return pool;
}

function squat(pool, hash, sk, content = 'AAAA') {
  const event = finalizeEvent({
    kind: NOTE_KIND,
    created_at: Math.floor(Date.now() / 1000) + 3600,
    tags: [['d', hash]],
    content,
  }, sk);
  pool.published.push(event);
  return event;
}

test('a newer event from a stranger on the same d tag cannot make the buyer\'s note look altered', async () => {
  const pool = filteringPool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity: buyer, text: '12 Elm St', pool, relays });
  squat(pool, hash, attackerSk);
  const fragment = url.split('#')[1];
  // The vendor knows the buyer from the chat and asks for that key only.
  const opened = await openDeadDropNote({ identity: vendor, fragment, pool, relays, author: buyer.pk, hold: true });
  assert.equal(opened.text, '12 Elm St');
  assert.deepEqual(pool.filters.at(-1).authors, [buyer.pk]);
});

test('a relay that ignores the authors filter is not trusted, and a bare link skips what its key cannot open', async () => {
  const pool = fakePool(); // ignores authors on purpose
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity: buyer, text: 'real', pool, relays });
  squat(pool, hash, attackerSk);
  const fragment = url.split('#')[1];
  assert.equal((await openDeadDropNote({ identity: vendor, fragment, pool, relays, author: buyer.pk, hold: true })).text, 'real');
  assert.equal((await openDeadDropNote({ identity: vendor, fragment, pool, relays, hold: true })).text, 'real');
  // Only a stranger's event exists for that author: nothing to open.
  const lone = filteringPool();
  const made = await createDeadDropNote({ identity: { sk: attackerSk }, text: 'planted', pool: lone, relays });
  await assert.rejects(
    () => openDeadDropNote({ identity: vendor, fragment: made.url.split('#')[1], pool: lone, relays, author: buyer.pk }),
    /gone|never/,
  );
});

test('a reader\'s burn marks the local ledger only; relays would ignore its delete, so none is sent', async () => {
  const pool = filteringPool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity: buyer, text: 'for the vendor', pool, relays });
  const before = pool.published.length;
  const opened = await openDeadDropNote({ identity: vendor, fragment: url.split('#')[1], pool, relays, author: buyer.pk, hold: true });
  assert.equal(deadDropConsumed(hash), false, 'held open until the caller burns');
  await opened.burn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(deadDropConsumed(hash), true);
  assert.equal(pool.published.length, before, 'no kind-5 from a key that did not sign the note');
});

test('the writer opening its own note still asks relays to drop it', async () => {
  const pool = filteringPool();
  const relays = ['wss://relay.test'];
  const { url } = await createDeadDropNote({ identity: buyer, text: 'mine', pool, relays });
  const before = pool.published.length;
  await openDeadDropNote({ identity: buyer, fragment: url.split('#')[1], pool, relays });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pool.published[before].kind, 5);
});

// Synthetic end-to-end for both link shapes the app hands out. No network: the
// fake pool stands in for the relay, so what is checked is the link the app
// builds and the reader's own open, not a relay's answer.
test('a generated standalone note link lands on the app host and opens for its reader', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url, hash } = await createDeadDropNote({ identity: buyer, text: '12 Elm St', pool, relays });

  const link = new URL(url);
  assert.equal(link.origin, entryById('app-host').url);
  assert.equal(link.pathname, '/note');
  assert.equal(link.search, '', 'the key rides in the fragment, never in the query');
  assert.ok(link.hash.length > 1, 'the fragment carries the key');
  assert.ok(!url.includes(hash), 'the relay lookup hash stays out of the link');

  // What useChatBootstrap does with a pasted link: take the fragment, open it.
  const opened = await openDeadDropNote({ identity: vendor, fragment: link.hash.slice(1), pool, relays });
  assert.equal(opened.text, '12 Elm St');
});

test('a generated checkout delivery link opens for the vendor who was sent it', async () => {
  const pool = fakePool();
  const relays = ['wss://relay.test'];
  const { url } = await createDeadDropNote({ identity: buyer, text: '12 Elm St', pool, relays });

  // OneTapCheckout puts the url on the order event as delivery.note; the
  // vendor's screen (useCommerce, open_delivery_note) takes the fragment from
  // it and asks for the buyer's own event only.
  const order = { pubkey: buyer.pk, data: { delivery: { note: url } } };
  const fragment = String(order.data.delivery.note).split('#')[1] || '';
  assert.ok(fragment);
  const opened = await openDeadDropNote({ identity: vendor, fragment, pool, relays, author: order.pubkey, hold: true });
  assert.equal(opened.text, '12 Elm St');
});


// ————— the one-read carrier (S4) —————
// A fake host that behaves like scripts/note-carrier.mjs: it stores what it is
// posted, hands it over once, and answers the health probe. No network.
function fakeCarrier({ health = true } = {}) {
  const notes = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, body: init.body || null });
    if (u.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: health }), { status: health ? 200 : 404 });
    }
    const m = /^\/api\/notes\/([A-Za-z0-9_-]{22})$/.exec(u.pathname);
    if (!m) return new Response('{"error":"not-found"}', { status: 404 });
    if (method === 'POST') {
      if (notes.has(m[1])) return new Response('{"error":"exists"}', { status: 409 });
      notes.set(m[1], new Uint8Array(init.body));
      return new Response(JSON.stringify({ id: m[1] }), { status: 201 });
    }
    if (!notes.has(m[1])) return new Response('{"error":"gone"}', { status: 404 });
    const bytes = notes.get(m[1]);
    notes.delete(m[1]);
    return new Response(bytes, { status: 200 });
  };
  return { fetchImpl, notes, calls };
}

test('a carrier note reads once and is gone from the host afterwards', async () => {
  forgetCarrierProbe();
  const host = fakeCarrier();
  const origin = 'https://notes.test';
  const made = await createCarrierNote({ text: 'one read only', origin, fetchImpl: host.fetchImpl });
  const fragment = made.url.split('#')[1];
  assert.ok(isCarrierFragment(fragment), 'the link carries a carrier fragment, told apart by its version byte');
  assert.equal(Buffer.from(fragment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 61);
  assert.ok(!made.url.split('#')[0].includes('?'));

  const opened = await openCarrierNote({ fragment, origin, fetchImpl: host.fetchImpl });
  assert.equal(opened.text, 'one read only');
  // The host holds nothing afterwards, and the second read is refused.
  assert.equal(host.notes.size, 0);
  // The honest line, in the reader's own words: a 404 from the host says only
  // that the note is not there. It cannot say who read it — the reader whose
  // own slow fetch burned it gets the same 404 as a stranger tapping twice, and
  // "already been read" tells the first of them something untrue about a note
  // they never saw.
  await assert.rejects(
    () => openCarrierNote({ fragment, origin, fetchImpl: host.fetchImpl }),
    /The note is gone or was never here\./,
  );
});

test('the carrier never receives the key: the body is sealed, the path is an id', async () => {
  forgetCarrierProbe();
  const host = fakeCarrier();
  const origin = 'https://notes.test';
  const made = await createCarrierNote({ text: 'address: 12 Elm St', origin, fetchImpl: host.fetchImpl });
  const post = host.calls.find((c) => c.method === 'POST');
  assert.ok(post, 'the note was posted');
  assert.match(post.path, /^\/api\/notes\/[A-Za-z0-9_-]{22}$/);
  const body = Buffer.from(post.body).toString('latin1');
  assert.ok(!body.includes('12 Elm St'), 'the plaintext never reaches the host');
  const fragment = made.url.split('#')[1];
  const raw = Buffer.from(fragment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const key = raw.slice(17, 49);
  assert.ok(!Buffer.from(post.body).includes(key), 'the key never reaches the host');
});

test('a sealed note that is altered does not open', async () => {
  forgetCarrierProbe();
  const host = fakeCarrier();
  const origin = 'https://notes.test';
  const made = await createCarrierNote({ text: 'do not touch', origin, fetchImpl: host.fetchImpl });
  const fragment = made.url.split('#')[1];
  const id = Buffer.from(fragment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').slice(1, 17).toString('base64url');
  const sealed = host.notes.get(id);
  sealed[0] ^= 0xff;
  await assert.rejects(
    () => openCarrierNote({ fragment, origin, fetchImpl: host.fetchImpl }),
    /link was altered/,
  );
});

test('no host means no carrier note, and the reason says so', async () => {
  forgetCarrierProbe();
  await assert.rejects(
    () => createCarrierNote({ text: 'x', origin: '' }),
    /note host is not set/,
  );
  assert.equal(await carrierAvailable('', async () => { throw new Error('no network'); }), false);
});

test('createNoteLink reports the transport it actually used', async () => {
  forgetCarrierProbe();
  const pool = fakePool();
  const relays = ['wss://relay.test'];

  const carrierHost = fakeCarrier();
  const viaCarrier = await createNoteLink({
    identity, text: 'through the host', pool, relays,
    origin: 'https://notes.test', fetchImpl: carrierHost.fetchImpl,
  });
  assert.equal(viaCarrier.carrier, true);
  assert.ok(isCarrierFragment(viaCarrier.url.split('#')[1]));
  assert.equal(pool.published.length, 0, 'nothing went to a relay when the host is a carrier');

  forgetCarrierProbe();
  const plainHost = fakeCarrier({ health: false });
  const viaRelay = await createNoteLink({
    identity, text: 'through the relay', pool, relays,
    origin: 'https://plain.test', fetchImpl: plainHost.fetchImpl,
  });
  assert.equal(viaRelay.carrier, false);
  assert.equal(pool.published.filter((e) => e.kind === NOTE_KIND).length, 1);
});

test('a carrier link opened in the app goes to the host, not the relay', async () => {
  forgetCarrierProbe();
  const host = fakeCarrier();
  const origin = 'https://notes.test';
  const made = await createCarrierNote({ text: '12 Elm St', origin, fetchImpl: host.fetchImpl });
  const fragment = made.url.split('#')[1];
  const pool = fakePool();
  // The host answers; the relay fake holds nothing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = host.fetchImpl;
  try {
    const opened = await openDeadDropNote({
      identity, fragment, pool, relays: ['wss://relay.test'],
    });
    assert.equal(opened.text, '12 Elm St');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(pool.published.length, 0, 'no relay event was consulted for a carrier link');
});

// The founder ruled the promise prose off the burn-note sheet: it says "Burn
// note" and nothing else. This is a shape assertion on the source, not a
// behaviour test — the reader's experience is AUDITOR's probe, not this. It
// goes red if any removed promise line comes back, in visible text or in a
// comment that states the mechanic as fact.
test('the burn-note sheet carries no promise prose, in text or in a comment', () => {
  const source = readFileSync(new URL('../components/chat/DeadDropModal.jsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  for (const phrase of ['opens once', 'shows once', 'not saved anywhere', 'gone after']) {
    assert.equal(source.includes(phrase), false, `the burn-note sheet carries "${phrase}" again`);
  }
});
