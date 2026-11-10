// Colocated focused test for src/lib/protocolTestDm/sessionStore.js
// (TEST-PATH-ONLY). Proves: all-or-none commit, injected sealer round-trip,
// fail-closed on missing sealer/storage, and the crash-between-steps rollback.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_STORE_KEYS,
  SealedSessionStore,
  createSnapshotRollbackRunner,
} from './sessionStore.js';

function memoryStorage() {
  const map = new Map();
  return {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    keys() { return [...map.keys()]; },
  };
}

// Deterministic XOR sealer over a fixed 32-byte key; adequate ONLY to prove
// sealing plumbing (AAD binding + unseal), not a real vault claim. It fails
// closed when the AAD differs, which is what the store relies on.
function xorSealer(rawKeyBytes = new Uint8Array(32).fill(0x5a)) {
  const encoder = new TextEncoder();
  const seal = (plaintext, aad) => {
    const data = encoder.encode(plaintext);
    const out = new Uint8Array(data.length);
    const aadSum = [...encoder.encode(aad)].reduce((acc, b) => acc + b, 0) & 0xff;
    for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ rawKeyBytes[i % rawKeyBytes.length] ^ aadSum;
    return Buffer.from(out).toString('base64');
  };
  const open = (ciphertext, aad) => {
    const raw = new Uint8Array(Buffer.from(ciphertext, 'base64'));
    const aadSum = [...encoder.encode(aad)].reduce((acc, b) => acc + b, 0) & 0xff;
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ rawKeyBytes[i % rawKeyBytes.length] ^ aadSum;
    return Buffer.from(out).toString('utf8');
  };
  return { seal, open };
}

function buildStore(storage) {
  return new SealedSessionStore({
    storage,
    sealer: xorSealer(),
    transactionRunner: createSnapshotRollbackRunner(storage),
  });
}

test('init creates meta exactly once', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  assert.deepEqual(await store.init(), { created: true });
  assert.deepEqual(await store.init(), { created: false });
});

test('apply commits session + outbox + journal together, sealed at rest', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.init();
  const result = await store.apply({
    sessionMutation: { sessionId: 'sess-1', state: { ratchetStep: 7, peerDeviceId: 'dev-b' } },
    outboxRow: { operationId: 'op-9', eventJson: '{"kind":1059}', targetRouteId: 'route-a' },
    inboundJournalEntry: { senderDeviceId: 'dev-a', operationId: 'op-in', dedupeDigest: 'd'.repeat(64) },
  }, { label: 'atomic-send' });
  assert.equal(result.committed, true);
  // Sealed at rest: ciphertext not plaintext.
  const sealedRaw = await storage.get(`${SESSION_STORE_KEYS.SESSION_PREFIX}sess-1`);
  assert.ok(!JSON.stringify(sealedRaw).includes('ratchetStep'));
  const state = await store.getSession('sess-1');
  assert.equal(state.ratchetStep, 7);
  const row = await store.getOutboxRow('op-9');
  assert.equal(row.operationId, 'op-9');
  const journal = await store.getInboundJournalEntry('dev-a', 'op-in');
  assert.equal(journal.dedupeDigest, 'd'.repeat(64));
});

test('missing session id or journal identity fails before any write', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.init();
  await assert.rejects(() => store.apply({ sessionMutation: { state: {} } }), /sessionId/);
  await assert.rejects(() => store.apply({ outboxRow: {} }), /operationId/);
  await assert.rejects(() => store.apply({ inboundJournalEntry: { senderDeviceId: 'a' } }), /senderDeviceId \+ operationId|operationId/);
  await assert.rejects(() => store.apply({}), /at least one record/);
  assert.equal([...storage.keys()].filter((k) => k !== SESSION_STORE_KEYS.META_KEY).length, 0);
});

test('CRASH BETWEEN STEPS: fault in a later put rolls back earlier writes', async () => {
  const base = memoryStorage();
  const store = buildStore(base);
  await store.init();
  // Pre-existing durable prior state that must survive untouched.
  const priorSession = `${SESSION_STORE_KEYS.SESSION_PREFIX}sess-old`;
  await base.put(priorSession, {
    version: 1, recordKind: 'session-state', aad: 'session|sess-old',
    ciphertext: xorSealer().seal(JSON.stringify({ ratchetStep: 3 }), 'session|sess-old'),
  });

  let applyDataPuts = 0;
  const crashStorage = {
    get: (key) => base.get(key),
    delete: (key) => base.delete(key),
    put: async (key, value) => {
      // Count every real data write of this apply; fail on the SECOND one,
      // i.e. crash between step 2 (outbox) and step 3 (journal).
      if (value?.recordKind === 'session-state' || value?.transactionLabel
        || value?.senderDeviceId) {
        applyDataPuts += 1;
        if (applyDataPuts >= 2 && value?.transactionLabel === 'crash') {
          throw new Error('simulated crash mid-sequence');
        }
      }
      return base.put(key, value);
    },
    keys: () => base.keys(),
  };
  const crashingStore = new SealedSessionStore({
    storage: crashStorage,
    sealer: xorSealer(),
    transactionRunner: createSnapshotRollbackRunner(crashStorage),
  });

  // Fault fires after TWO puts inside this apply (meta keys excluded).
  await assert.rejects(
    () => crashingStore.apply({
      sessionMutation: { sessionId: 'sess-new', state: { ratchetStep: 99 } },
      outboxRow: { operationId: 'op-crash' },
      inboundJournalEntry: { senderDeviceId: 'dev-x', operationId: 'op-y' },
    }, { label: 'crash' }),
    /simulated crash/,
  );
  // Nothing from the aborted apply survived...
  assert.equal(await crashingStore.getSession('sess-new'), null);
  assert.equal(await crashingStore.getOutboxRow('op-crash'), undefined);
  assert.equal(await crashingStore.getInboundJournalEntry('dev-x', 'op-y'), undefined);
  // ...and the prior durable state is intact.
  const survived = await crashingStore.getSession('sess-old');
  assert.equal(survived.ratchetStep, 3);
  // The same apply succeeds once the fault clears.
  applyDataPuts = -1;
  const okResult = await crashingStore.apply({
    sessionMutation: { sessionId: 'sess-new', state: { ratchetStep: 100 } },
    outboxRow: { operationId: 'op-crash' },
    inboundJournalEntry: { senderDeviceId: 'dev-x', operationId: 'op-y' },
  }, { label: 'after-crash' });
  assert.equal(okResult.committed, true);
  assert.equal((await crashingStore.getSession('sess-new')).ratchetStep, 100);
});

test('tampered sealed ciphertext fails closed on read', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.init();
  await store.apply({ sessionMutation: { sessionId: 's1', state: { v: 1 } } });
  const sealedRaw = await storage.get(`${SESSION_STORE_KEYS.SESSION_PREFIX}s1`);
  // Corrupt the sealed bytes directly: unseal must fail closed, not guess.
  await storage.put(`${SESSION_STORE_KEYS.SESSION_PREFIX}s1`, { ...sealedRaw, ciphertext: '!!!not-valid-sealed-bytes' });
  await assert.rejects(() => store.getSession('s1'));
});

test('store refuses missing sealer or broken storage shape', () => {
  assert.throws(() => new SealedSessionStore({ storage: memoryStorage(), sealer: {} }), /injected sealer/);
  assert.throws(() => new SealedSessionStore({ storage: null, sealer: xorSealer() }), /get\/put\/delete/);
});
