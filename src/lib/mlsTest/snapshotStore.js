// Copy-on-write snapshot store for the MLS v1 test profile
// (docs/MLS-TEST-PROFILE-V1.md Section 2, plan item 14).
//
// TEST PROFILE ONLY. A state snapshot is tentative until its matching
// protocol event or journal row commits in the same transaction. The store
// shape follows the fake-indexeddb-compatible API the repo's browser tests
// already use (async get/put/delete plus objectStore transactions) so the
// same code path runs against real IndexedDB in the browser later.

// Minimal async KV store with the same surface the IndexedDB path exposes:
// get(key), put(key, value), delete(key), clear(). Swap in the real
// IndexedDB-backed adapter later without touching callers.
export function createMemoryKv() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
    async clear() { map.clear(); },
    _keys: () => [...map.keys()],
  };
}

// Atomic transaction over one or more stores. stores is an object whose
// values are stores exposing the async KV surface above. `work` receives a
// snapshot view. If `work` throws or the after-assertions fail, every store
// is rolled back to the transaction's starting state.
export async function transaction(stores, work) {
  const names = Object.keys(stores);
  const snapshots = new Map(names.map((n) => [n, structuredClone(stores[n]._keys === undefined ? null : null)]));
  // Snapshot by reading every key (memory stores expose _keys; IndexedDB
  // adapters will expose cursorAll). Save each store's full contents.
  const saved = new Map();
  for (const name of names) {
    const store = stores[name];
    const keys = typeof store._keys === 'function' ? store._keys() : await store.allKeys();
    const contents = [];
    for (const key of keys) contents.push([key, await store.get(key)]);
    saved.set(name, contents);
  }
  try {
    const result = await work({ stores });
    return result;
  } catch (error) {
    // Roll back: delete what the transaction added, restore prior values.
    for (const name of names) {
      const store = stores[name];
      await store.clear();
      for (const [key, value] of saved.get(name)) {
        if (value !== undefined) await store.put(key, value);
      }
    }
    error._rolledBack = true;
    throw error;
  } finally {
    void snapshots;
  }
}

// Sealed state wrapper. In test mode "sealing" is the same envelope the
// ratchetStateAtRest path uses conceptually; here it is a marker the
// transaction treats as atomic with the journal row.
function sealValue(owner, collection, id, value) {
  return { owner, collection, id, sealedAt: Date.now(), value };
}

export class MlsSnapshotConflict extends Error {
  constructor(groupId) {
    super(`MLS group state changed while processing ${groupId}.`);
    this.name = 'MlsSnapshotConflict';
  }
}

// Copy-on-write MLS group store.
//   prepare: stage a candidate snapshot without advancing active state.
//   commit: atomically write the staged state, the governance revision,
//           and the immutable outbox/journal row; any failure discards the
//           candidate and the pre-operation snapshot stays active.
export function createMlsSnapshotStore({ owner, stateKv = createMemoryKv(), journalKv = createMemoryKv() } = {}) {
  const ownerName = owner || 'test-owner';
  const states = stateKv;
  const journal = journalKv;
  const candidates = new Map();

  return {
    states,
    journal,
    async load(groupId) {
      const row = await states.get(`mls-groups:${groupId}`);
      return row ? { version: row.version, value: row.value } : null;
    },
    // Stage a Welcome or commit result on a copy. Failure paths (including
    // OpenMLS #2316 Welcome consumption) never touch active state.
    async stage(groupId, mutate, { expectedVersion = null } = {}) {
      const current = await states.get(`mls-groups:${groupId}`);
      if (expectedVersion !== null && (current?.version ?? null) !== expectedVersion) {
        throw new MlsSnapshotConflict(groupId);
      }
      const candidate = structuredClone(current?.value ?? null);
      const next = await mutate(candidate);
      candidates.set(groupId, { value: next, baseVersion: current?.version ?? null });
      return next;
    },
    // Discard a staged candidate (failed Welcome); the KeyPackage survives.
    discard(groupId) { candidates.delete(groupId); },
    // Atomic commit of the candidate: MLS state + governance revision +
    // outbox/journal row in one transaction. Failure discards everything.
    async commit(groupId, { governanceRevision, outboxEventId, outboxEvent = null } = {}) {
      const candidate = candidates.get(groupId);
      if (!candidate) throw new Error(`No staged MLS snapshot for ${groupId}.`);
      await transaction({ states, journal }, async ({ stores }) => {
        const current = await stores.states.get(`mls-groups:${groupId}`);
        if ((current?.version ?? null) !== candidate.baseVersion) {
          throw new MlsSnapshotConflict(groupId);
        }
        if (outboxEventId && await stores.journal.get(outboxEventId)) {
          throw new Error('This MLS event is already durable; retry the existing outbox row.');
        }
        const nextVersion = candidate.baseVersion === null ? 0 : candidate.baseVersion + 1;
        await stores.states.put(`mls-groups:${groupId}`, {
          groupId,
          version: nextVersion,
          updatedAt: Date.now(),
          governanceRevision,
          value: candidate.value,
        });
        if (outboxEventId) {
          await stores.journal.put(outboxEventId, {
            id: outboxEventId, event: outboxEvent ?? null, at: Date.now(), owner: ownerName,
            sealed: sealValue(ownerName, 'mls-outbox', outboxEventId, outboxEvent ?? null),
          });
        }
      });
      candidates.delete(groupId);
      return (await states.get(`mls-groups:${groupId}`))?.version ?? null;
    },
  };
}
