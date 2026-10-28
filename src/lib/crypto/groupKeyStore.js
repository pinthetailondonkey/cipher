import { db, currentOwner } from '../../db';
import { toHex } from './groupCipher';
import { sealGroupKeyRow, openGroupKeyRow, isLegacyKeyRow, groupKeysUnlocked, GroupKeyLockedError } from './groupKeyAtRest';
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

// Rows saved before keys were sealed at rest are resealed the first time the
// store is used while unlocked, once per account. Each row is re-read inside
// its own transaction, so a concurrent putGroupKey that already sealed it (or
// changed it) is never overwritten with stale bytes.
const resealed = new Set();
async function resealLegacyRows() {
  const owner = store.owner();
  if (!owner || resealed.has(owner)) return;
  resealed.add(owner);
  try {
    const rows = await store.db.groupKeys.toArray();
    for (const row of rows) {
      if (!isLegacyKeyRow(row)) continue;
      // Sealed before the transaction opens: WebCrypto is not a database
      // request, and awaiting it inside one lets the transaction close.
      const { sealed } = await sealGroupKeyRow(row);
      await store.db.transaction('rw', store.db.groupKeys, async () => {
        const held = await store.db.groupKeys.get(row.id);
        if (!isLegacyKeyRow(held) || held.keyHex !== row.keyHex) return;
        const { keyHex, ...rest } = held;
        await store.db.groupKeys.put({ ...rest, sealed });
      });
    }
  } catch (error) {
    // Try again on the next use; the plaintext row is still readable.
    resealed.delete(owner);
    console.error('[group-key] Stored keys could not be sealed at rest:', error?.name || error);
  }
}

export async function getGroupKey(groupId, epoch) {
  if (!usable()) return null;
  await resealLegacyRows();
  const row = await store.db.groupKeys.where('[groupId+epoch]').equals([groupId, epoch]).first();
  if (!row) return null;
  try { return await openGroupKeyRow(row); } catch (error) {
    // An unreadable key reads as "no key": the message stays pending, nothing
    // is decrypted with a wrong key and nothing is overwritten.
    console.error('[group-key] A stored group key could not be opened:', groupId, epoch, error?.name || error);
    return null;
  }
}
export async function getCurrentGroupKey(groupId) {
  if (!usable()) return null;
  await resealLegacyRows();
  const rows = await store.db.groupKeys.where('groupId').equals(groupId).toArray();
  if (!rows.length) return null;
  const latest = rows.reduce((a, b) => (a.epoch > b.epoch ? a : b));
  // Throws when the newest key cannot be opened. Returning null here would
  // read as "this group has no key" and let a caller mint a fresh key over
  // the unreadable epoch; returning an older epoch would send under a stale one.
  const bytes = await openGroupKeyRow(latest);
  return { epoch: latest.epoch, bytes, obtainedAt: latest.obtainedAt };
}
export async function getAllGroupKeys(groupId) {
  if (!usable()) return [];
  await resealLegacyRows();
  const rows = await store.db.groupKeys.where('groupId').equals(groupId).toArray();
  const out = [];
  for (const r of rows) {
    try { out.push({ epoch: r.epoch, bytes: await openGroupKeyRow(r) }); } catch (error) {
      console.error('[group-key] A stored group key could not be opened:', groupId, r.epoch, error?.name || error);
    }
  }
  return out;
}
export async function putGroupKey(groupId, epoch, raw, meta = {}) {
  if (!ready()) return;
  // Refuses, never writes plaintext, when the session secret is gone.
  if (!groupKeysUnlocked()) throw new GroupKeyLockedError();
  await resealLegacyRows();
  // Sealed before the transaction opens (WebCrypto inside one would let it
  // close); the seal depends only on group, epoch and key, not on the held row.
  const { sealed } = await sealGroupKeyRow({ groupId, epoch, keyHex: toHex(raw) });
  await store.db.transaction('rw', store.db.groupKeys, async () => {
    // The table's &[groupId+epoch] index is unique and a put without the
    // ++id auto-key inserts — a second write for an epoch the device
    // already holds crashed the install with ConstraintError instead of
    // rewriting the row. Upsert on the pair, and a re-delivery is a
    // rewrite, not a crash. The held obtainedAt survives: re-stating the
    // held epoch must not move the baseline the grant path reads.
    const held = await store.db.groupKeys.where('[groupId+epoch]').equals([groupId, epoch]).first();
    await store.db.groupKeys.put({
      groupId,
      epoch,
      sealed,
      isCurrent: true,
      obtainedAt: held ? held.obtainedAt : Math.floor(Date.now() / 1000),
      ...(held ? { id: held.id } : {}),
      ...meta,
    });
    await store.db.groupKeys.where('groupId').equals(groupId).modify(row => { if (row.epoch !== epoch) row.isCurrent = false; });
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cipher:group-key-updated', { detail: { groupId, epoch } }));
  }
}
export async function getGrantedEpochsFor(groupId, pubkey) {
  if (!ready()) return new Set();
  const rows = await db.groupKeyGrants.where('[groupId+pubkey+epoch]').between([groupId, pubkey, -Infinity], [groupId, pubkey, Infinity]).toArray();
  return new Set(rows.map(r => r.epoch));
}
export async function recordGrant(groupId, pubkey, epoch) {
  if (!ready()) return;
  await db.groupKeyGrants.put({ groupId, pubkey, epoch, sentAt: Math.floor(Date.now() / 1000) });
}
