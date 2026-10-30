import assert from 'node:assert/strict';
import test from 'node:test';
import { _deadDropInternals, createCarrierNote } from './deadDrop.js';
import { openNoteLink } from './noteReader.js';

// The page reaches its host through the egress registry, so the test sets the
// one entry the carrier path reads. Every fetch below is answered by the test:
// nothing here touches a network.
function pointAtCarrierHost() {
  const memory = new Map([
    ['cipher_network', JSON.stringify({ overrides: { 'dead-drop': 'http://carrier.test' } })],
  ]);
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  globalThis.sessionStorage = globalThis.localStorage;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Seal a note through the product's own writer, catching the bytes it posts so
// the read below can hand back exactly those.
async function sealedCarrier(text) {
  let posted = null;
  globalThis.fetch = async (url, options) => {
    posted = options.body;
    return { ok: true, status: 201 };
  };
  const made = await createCarrierNote({ text, origin: 'http://carrier.test' });
  return { fragment: made.url.split('#')[1], bytes: posted };
}

// The host is slow to answer: the note is already taken by the time the page's
// deadline would fire.
function slowAnswer(bytes, status = 200, delayMs = 60) {
  return async () => {
    await sleep(delayMs);
    return {
      ok: status === 200,
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

// A relay socket that accepts and never speaks. The query cannot finish, which
// is the shape the deadline exists for.
class SilentSocket {
  constructor(url) { this.url = url; this.readyState = 0; }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

test('a carrier answer that arrives after the deadline still opens the note', async () => {
  pointAtCarrierHost();
  const note = await sealedCarrier('the line nobody may lose');
  globalThis.fetch = slowAnswer(note.bytes);
  // The deadline is far shorter than the host's answer. On a carrier note that
  // must not matter: the host has already handed the note over and deleted it,
  // so the only copy is the one on its way back. Giving up here would spend the
  // note without ever showing it.
  const opened = await openNoteLink({ fragment: note.fragment, timeoutMs: 10 });
  assert.equal(opened.text, 'the line nobody may lose');
  assert.equal(opened.transport, 'carrier');
  assert.equal(typeof opened.burn, 'function', 'the burn still rides with the text');
});

test('a carrier note that is gone says so, even when the answer is late', async () => {
  pointAtCarrierHost();
  const note = await sealedCarrier('never handed over');
  globalThis.fetch = slowAnswer(note.bytes, 404);
  await assert.rejects(
    openNoteLink({ fragment: note.fragment, timeoutMs: 10 }),
    /The note is gone or was never here\./,
    'the host\'s own answer is the one the person reads',
  );
});

test('a silent relay still gives up on the deadline', async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = SilentSocket;
  try {
    const fragment = _deadDropInternals.packFragment(
      new Uint8Array(32).fill(9), new Uint8Array(12).fill(3), new Uint8Array(32).fill(5),
    );
    // The bound below is the assertion, not just a guard: it is shorter than
    // the shipped eight seconds, so a deadline that ignored the caller's
    // `timeoutMs` and used the constant would still be waiting here and the
    // test would say so instead of passing.
    //
    // The reader builds its pool before it starts the deadline, so the module
    // load is warmed here for the same reason: what is being timed is the wait,
    // not node loading nostr-tools the first time.
    await import('nostr-tools');
    const started = Date.now();
    const outcome = await Promise.race([
      openNoteLink({ fragment, relays: ['wss://silent.invalid'], timeoutMs: 200 })
        .then(() => 'opened', (error) => `rejected: ${error.message}`),
      sleep(1000).then(() => 'still waiting after 1000ms'),
    ]);
    assert.equal(outcome, 'rejected: The note could not be opened.',
      'a relay that never answers still ends, inside the deadline it was given');
    assert.ok(Date.now() - started < 1000, 'and it ends on the caller\'s deadline, not a hardcoded one');
  } finally {
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  }
});
