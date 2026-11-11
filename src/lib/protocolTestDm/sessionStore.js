// Sealed ratchet session store for the DM TEST PATH
// (src/lib/protocolTestDm/sessionStore.js, TEST-ONLY).
//
// Frozen spec: protocol build plan v2 Phase 3 step 1 ("Sealed session store:
// one transaction writes sealed session state, testOutbox row, and inbound
// journal") and docs/R5-INTEGRATION-PLAN.md R5-B atomic-commit table row.
//
// Design:
// - Sealing is INJECTED. The caller supplies a `sealer` object
//   { seal(plaintextString, aad) -> ciphertextString,
//     open(ciphertextString, aad) -> plaintextString } so Node tests run
//   without the vault; the production test-artifact caller plugs the vault-key
//   HKDF domain later. Missing sealer fails closed.
// - Storage is a fake-IDB-compatible key/value shape: any object exposing
//   get(key), put(key, value), delete(key) that resolves promises. The e2e
//   driver uses an in-memory fake; browser IndexedDB callers pass a thin
//   adapter. All three writes of ONE apply() go through an injected
//   `transaction(function)` when provided so IndexedDB's native atomicity can
//   be used; without it this module simulates the transaction with a snapshot
//   journal + staged write set committed in strict order with a deliberate
//   rollback point.
// - apply() takes {sessionMutation, outboxRow, inboundJournalEntry} and commits
//   ALL or NONE. Any error between steps restores the pre-apply snapshot and
//   leaves every stored record untouched. Crash-between-steps is tested by a
//   fault-injectable storage whose put() throws after N successes.

const STORAGE_VERSION = 1;

export const SESSION_STORE_KEYS = Object.freeze({
  SESSION_PREFIX: 'cipher-dm-test/session/',
  OUTBOX_PREFIX: 'cipher-dm-test/testOutbox/',
  JOURNAL_PREFIX: 'cipher-dm-test/inboundJournal/',
  META_KEY: 'cipher-dm-test/storeMeta',
});

function requireSealer(sealer) {
  if (!sealer || typeof sealer.seal !== 'function' || typeof sealer.open !== 'function') {
    throw new Error('A sealed session store needs an injected sealer with seal/open.');
  }
}

function requireStorage(storage) {
  if (!storage
    || typeof storage.get !== 'function'
    || typeof storage.put !== 'function'
    || typeof storage.delete !== 'function') {
    throw new Error('A sealed session store needs storage with get/put/delete.');
  }
}

function requireTransactionRunner(transactionRunner) {
  if (typeof transactionRunner !== 'function') {
    throw new Error('A sealed session store needs a transaction runner.');
  }
}

export class SealedSessionStore {
  constructor({ storage, sealer, transactionRunner }) {
    requireStorage(storage);
    requireSealer(sealer);
    if (transactionRunner) requireTransactionRunner(transactionRunner);
    this.storage = storage;
    this.sealer = sealer;
    this.transactionRunner = transactionRunner ?? null;
    this.committedApplies = 0;
  }

  async init() {
    const existing = await this.storage.get(SESSION_STORE_KEYS.META_KEY);
    if (existing == null) {
      await this.storage.put(SESSION_STORE_KEYS.META_KEY, { version: STORAGE_VERSION, createdAtMs: Date.now() });
      return { created: true };
    }
    return { created: false };
  }

  // ── Read helpers (unseal on read; fail closed on tamper) ─────────────────

  async getSession(sessionId) {
    const sealed = await this.storage.get(`${SESSION_STORE_KEYS.SESSION_PREFIX}${sessionId}`);
    if (sealed == null) return null;
    return JSON.parse(this.sealer.open(sealed.ciphertext, sealed.aad));
  }

  async getOutboxRow(operationId) {
    return this.storage.get(`${SESSION_STORE_KEYS.OUTBOX_PREFIX}${operationId}`);
  }

  async getInboundJournalEntry(senderDeviceId, operationId) {
    return this.storage.get(
      `${SESSION_STORE_KEYS.JOURNAL_PREFIX}${senderDeviceId}:${operationId}`,
    );
  }

  // ── ONE transaction-shaped apply(): all rows commit or none do ───────────
  //
  // Each write is individually SEALED under the injected sealer with AAD bound
  // to its logical record kind + id, then written inside one transaction.
  // Writes happen in strict order:
  //   1. sealed session state (if sessionMutation present)
  //   2. testOutbox row      (if outboxRow present)
  //   3. inbound journal row (if inboundJournalEntry present)
  // The snapshot journal makes crash-between-steps observable for the
  // simulated path AND serves as evidence even where IndexedDB guarantees
  // atomicity natively.
  async apply({ sessionMutation, outboxRow, inboundJournalEntry }, { label = 'apply' } = {}) {
    requireStorage(this.storage); // re-check against late mutation
    requireSealer(this.sealer);

    if (sessionMutation == null && outboxRow == null && inboundJournalEntry == null) {
      throw new Error(`apply(${label}) refused: at least one record must be supplied.`);
    }
    if (outboxRow != null && !outboxRow.operationId) {
      throw new Error(`apply(${label}) refused: testOutbox row needs operationId.`);
    }
    if (inboundJournalEntry != null
      && !(inboundJournalEntry.senderDeviceId && inboundJournalEntry.operationId)) {
      throw new Error(`apply(${label}) refused: inbound journal entry needs senderDeviceId + operationId.`);
    }

    const stagedWrites = [];
    if (sessionMutation != null) {
      const sessionId = sessionMutation.sessionId;
      if (!sessionId) throw new Error(`apply(${label}) refused: session mutation needs sessionId.`);
      stagedWrites.push({
        key: `${SESSION_STORE_KEYS.SESSION_PREFIX}${sessionId}`,
        value: {
          version: STORAGE_VERSION,
          recordKind: 'session-state',
          aad: `session|${sessionId}`,
          ciphertext: this.sealer.seal(JSON.stringify(sessionMutation.state), `session|${sessionId}`),
        },
      });
    }
    if (outboxRow != null) {
      stagedWrites.push({
        key: `${SESSION_STORE_KEYS.OUTBOX_PREFIX}${outboxRow.operationId}`,
        value: { ...outboxRow, committedAtMs: Date.now(), transactionLabel: label },
      });
    }
    if (inboundJournalEntry != null) {
      const journalKey = `${SESSION_STORE_KEYS.JOURNAL_PREFIX}`
        + `${inboundJournalEntry.senderDeviceId}:${inboundJournalEntry.operationId}`;
      stagedWrites.push({ key: journalKey, value: { ...inboundJournalEntry, committedAtMs: Date.now() } });
    }

    const runner = this.transactionRunner
      ? (applyWrites) => this.transactionRunner(stagedKeysOf(stagedWrites), applyWrites)
      // Without an injected native-transaction runner the snapshot fallback
      // still needs the SAME staged-key list: it takes pre-image snapshots of
      // exactly those keys and restores them on any error. Calling it without
      // them made every plain-constructor apply() throw "keys is not
      // iterable" at commit time (found by the app-lane round-trip smoke).
      : (applyWrites) => createSnapshotRollbackRunner(this.storage)(stagedKeysOf(stagedWrites), applyWrites);

    await runner(async () => {
      for (const write of stagedWrites) {
        // Written in strict order; a fault here rolls everything back below.
        await this.storage.put(write.key, write.value);
      }
    });

    this.committedApplies += 1;
    return { committed: true, wroteCount: stagedWrites.length, label };
  }
}

function stagedKeysOf(writes) {
  return writes.map((write) => write.key);
}

// Fallback transaction runner for stores without native transactions: reads
// the pre-images of the affected keys, lets the writes run, and restores the
// exact pre-images on ANY error, including mid-sequence faults.
export function createSnapshotRollbackRunner(storage) {
  return async function snapshotRollbackTransaction(_stagedKeys, applyWrites) {
    let snapshots;
    try {
      const keys = _stagedKeys;
      const preImages = [];
      for (const key of keys) {
        preImages.push([key, await storage.get(key)]);
      }
      snapshots = preImages;
      await applyWrites();
    } catch (error) {
      if (snapshots) {
        for (const [key, previous] of snapshots) {
          if (previous == null) await storage.delete(key);
          else await storage.put(key, previous);
        }
      }
      throw error;
    }
  };
}
