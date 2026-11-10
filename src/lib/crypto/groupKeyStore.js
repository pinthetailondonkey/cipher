import { db, currentOwner, runAccountDbWriteForFence } from '../../db';
import { toHex } from './groupCipher';
import { sealGroupKeyRow, openGroupKeyRow, isLegacyKeyRow, groupKeysUnlocked, GroupKeyLockedError, sealDocKeyRow, openDocKeyRow } from './groupKeyAtRest';
let store = { db, owner: currentOwner };
// Test seam: lets the node tests run the real store against an in-memory
// table (the project has no IndexedDB in node). Not used by the app.
export function __setGroupKeyStoreForTests(next) {
  store = next || { db, owner: currentOwner };
  resealed.clear();
}
const ready = () => !!store.owner();
// Keys are readable only while the account is open AND the session secret is
// present. A locked app gets "no key", never plaintext, never a throw that
// would crash a decode loop.
const usable = () => ready() && groupKeysUnlocked();

function assertCapturedFence(securityFence, { write = false } = {}) {
  if (!securityFence) {
    if (write && store.db === db) {
      const error = new Error('A captured account security context is required for group-key writes.');
      error.code = 'SECURITY_CONTEXT_EXPIRED';
      throw error;
    }
    return;
  }
  if (securityFence.context?.owner !== store.owner()) {
    const error = new Error('The group-key operation belongs to a different account context.');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  }
  securityFence.assertCurrent();
}

function writeTransaction(securityFence, tables, callback) {
  assertCapturedFence(securityFence, { write: true });
  if (store.db === db) {
    return runAccountDbWriteForFence(securityFence, tables, callback);
  }
  return store.db.transaction('rw', ...tables.map((name) => store.db[name]),
    () => callback(store.db));
}

// Rows saved before keys were sealed at rest are resealed the first time the
// store is used while unlocked, once per account. Each row is re-read inside
// its own transaction, so a concurrent putGroupKey that already sealed it (or
// changed it) is never overwritten with stale bytes.
const resealed = new Set();
async function resealLegacyRows(securityFence = null) {
  const owner = store.owner();
  if (!owner || resealed.has(owner)) return;
  // Reading old rows does not need to mutate them. Production migration only
  // runs when its originating operation supplied the captured incarnation.
  if (store.db === db && !securityFence) return;
  assertCapturedFence(securityFence);
  resealed.add(owner);
  try {
    const rows = await store.db.groupKeys.toArray();
    assertCapturedFence(securityFence);
    for (const row of rows) {
      if (!isLegacyKeyRow(row)) continue;
      // Sealed before the transaction opens: WebCrypto is not a database
      // request, and awaiting it inside one lets the transaction close.
      const { sealed } = await sealGroupKeyRow(row);
      assertCapturedFence(securityFence);
      await writeTransaction(securityFence, ['groupKeys'], async (database) => {
        const held = await database.groupKeys.get(row.id);
        if (!isLegacyKeyRow(held) || held.keyHex !== row.keyHex) return;
        const rest = { ...held };
        delete rest.keyHex;
        await database.groupKeys.put({ ...rest, sealed });
      });
      assertCapturedFence(securityFence);
    }
  } catch (error) {
    // Try again on the next use; the plaintext row is still readable.
    resealed.delete(owner);
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    console.error('[group-key] Stored keys could not be sealed at rest:', error?.name || error);
  }
}

export async function getGroupKey(groupId, epoch, securityFence = null) {
  if (!usable()) return null;
  assertCapturedFence(securityFence);
  await resealLegacyRows(securityFence);
  const row = await store.db.groupKeys.where('[groupId+epoch]').equals([groupId, epoch]).first();
  assertCapturedFence(securityFence);
  if (!row) return null;
  try {
    const bytes = await openGroupKeyRow(row);
    assertCapturedFence(securityFence);
    return bytes;
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    // An unreadable key reads as "no key": the message stays pending, nothing
    // is decrypted with a wrong key and nothing is overwritten.
    console.error('[group-key] A stored group key could not be opened:', groupId, epoch, error?.name || error);
    return null;
  }
}
export async function getCurrentGroupKey(groupId, securityFence = null) {
  if (!usable()) return null;
  assertCapturedFence(securityFence);
  await resealLegacyRows(securityFence);
  const rows = await store.db.groupKeys.where('groupId').equals(groupId).toArray();
  assertCapturedFence(securityFence);
  if (!rows.length) return null;
  const latest = rows.reduce((a, b) => (a.epoch > b.epoch ? a : b));
  // Throws when the newest key cannot be opened. Returning null here would
  // read as "this group has no key" and let a caller mint a fresh key over
  // the unreadable epoch; returning an older epoch would send under a stale one.
  const bytes = await openGroupKeyRow(latest);
  assertCapturedFence(securityFence);
  return { epoch: latest.epoch, bytes, obtainedAt: latest.obtainedAt };
}
export async function getAllGroupKeys(groupId, securityFence = null) {
  if (!usable()) return [];
  assertCapturedFence(securityFence);
  await resealLegacyRows(securityFence);
  const rows = await store.db.groupKeys.where('groupId').equals(groupId).toArray();
  assertCapturedFence(securityFence);
  const out = [];
  for (const r of rows) {
    try {
      const bytes = await openGroupKeyRow(r);
      assertCapturedFence(securityFence);
      out.push({ epoch: r.epoch, bytes });
    } catch (error) {
      if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
      console.error('[group-key] A stored group key could not be opened:', groupId, r.epoch, error?.name || error);
    }
  }
  return out;
}
export async function putGroupKey(groupId, epoch, raw, meta = {}, securityFence = null) {
  if (!ready()) return;
  assertCapturedFence(securityFence, { write: true });
  // Refuses, never writes plaintext, when the session secret is gone.
  if (!groupKeysUnlocked()) throw new GroupKeyLockedError();
  await resealLegacyRows(securityFence);
  // Sealed before the transaction opens (WebCrypto inside one would let it
  // close); the seal depends only on group, epoch and key, not on the held row.
  const { sealed } = await sealGroupKeyRow({ groupId, epoch, keyHex: toHex(raw) });
  assertCapturedFence(securityFence, { write: true });
  await writeTransaction(securityFence, ['groupKeys'], async (database) => {
    // The table's &[groupId+epoch] index is unique and a put without the
    // ++id auto-key inserts — a second write for an epoch the device
    // already holds crashed the install with ConstraintError instead of
    // rewriting the row. Upsert on the pair, and a re-delivery is a
    // rewrite, not a crash. The held obtainedAt survives: re-stating the
    // held epoch must not move the baseline the grant path reads.
    const held = await database.groupKeys.where('[groupId+epoch]').equals([groupId, epoch]).first();
    await database.groupKeys.put({
      groupId,
      epoch,
      sealed,
      isCurrent: true,
      obtainedAt: held ? held.obtainedAt : Math.floor(Date.now() / 1000),
      ...(held ? { id: held.id } : {}),
      ...meta,
    });
    await database.groupKeys.where('groupId').equals(groupId).modify(row => { if (row.epoch !== epoch) row.isCurrent = false; });
  });
  assertCapturedFence(securityFence, { write: true });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cipher:group-key-updated', { detail: { groupId, epoch } }));
  }
}
export async function getGrantedEpochsFor(groupId, pubkey, securityFence = null) {
  if (!ready()) return new Set();
  assertCapturedFence(securityFence);
  const rows = await db.groupKeyGrants.where('[groupId+pubkey+epoch]').between([groupId, pubkey, -Infinity], [groupId, pubkey, Infinity]).toArray();
  assertCapturedFence(securityFence);
  return new Set(rows.map(r => r.epoch));
}
// Every grant the ledger holds, with when it was sent and, separately, when
// it last answered an explicit request (rate limiting counts only answers).
export async function getGrantRecords(groupId, pubkey, securityFence = null) {
  if (!ready()) return new Map();
  assertCapturedFence(securityFence);
  const rows = await db.groupKeyGrants.where('[groupId+pubkey+epoch]').between([groupId, pubkey, -Infinity], [groupId, pubkey, Infinity]).toArray();
  assertCapturedFence(securityFence);
  return new Map(rows.map((row) => [row.epoch, { sentAt: row.sentAt, answeredAt: row.answeredAt }]));
}
export async function recordGrant(groupId, pubkey, epoch, { answered = false, securityFence = null } = {}) {
  if (!ready()) return;
  assertCapturedFence(securityFence, { write: true });
  const sentAt = Math.floor(Date.now() / 1000);
  // Upsert on the pair: the unique [groupId+pubkey+epoch] index refuses a
  // second insert, and a re-grant to a member who asked again is a rewrite.
  const write = async (table) => {
    const held = await table.where('[groupId+pubkey+epoch]').equals([groupId, pubkey, epoch]).first();
    await table.put({
      groupId, pubkey, epoch, sentAt,
      ...(answered ? { answeredAt: sentAt } : (held?.answeredAt ? { answeredAt: held.answeredAt } : {})),
      ...(held ? { id: held.id } : {}),
    });
  };
  if (securityFence) {
    await runAccountDbWriteForFence(securityFence, ['groupKeyGrants'], (database) => write(database.groupKeyGrants));
  } else await write(db.groupKeyGrants);
  assertCapturedFence(securityFence, { write: true });
}

// ── Governance-doc key (SEC-1). Same store as chat keys (one owner-scoped
// IndexedDB), same sealed-at-rest law. A locked app sees 'no key', never
// plaintext — which is exactly how the doc seal/open treats it.
// Routes through `store` like the key rows so the node-suite seam injects it.
export async function putDocKey(groupId, epoch, keyBytes, securityFence = null) {
  if (!ready()) return false;
  try {
    assertCapturedFence(securityFence, { write: true });
    const row = await sealDocKeyRow({ groupId, epoch, keyBytes });
    assertCapturedFence(securityFence, { write: true });
    await writeTransaction(securityFence, ['groupDocKeys'], async (database) => {
      const existing = await database.groupDocKeys.get(groupId);
      if (existing) await database.groupDocKeys.delete(existing.groupId);
      await database.groupDocKeys.put(row);
    });
    assertCapturedFence(securityFence, { write: true });
    return true;
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    console.warn('[group-key] Could not store the governance-doc key:', error?.name || error);
    return false;
  }
}
export async function getDocKey(groupId, securityFence = null) {
  if (!usable()) return null; // locked: null means 'no key', like getCurrentGroupKey
  try {
    assertCapturedFence(securityFence);
    const row = await store.db.groupDocKeys.get(groupId);
    assertCapturedFence(securityFence);
    if (!row) return null;
    const bytes = await openDocKeyRow(row);
    assertCapturedFence(securityFence);
    return { epoch: Number.isInteger(row.epoch) ? row.epoch : 0, bytes };
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    console.warn('[group-key] A stored governance-doc key could not be opened:', error?.name || error);
    return null;
  }
}
export async function removeDocKey(groupId, securityFence = null) {
  if (!ready()) return false;
  try {
    assertCapturedFence(securityFence, { write: true });
    await writeTransaction(securityFence, ['groupDocKeys'], async (database) => {
      await database.groupDocKeys.delete(groupId);
    });
    assertCapturedFence(securityFence, { write: true });
    return true;
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    console.warn('[group-key] Could not restore the prior governance-doc key state:', error?.name || error);
    return false;
  }
}
