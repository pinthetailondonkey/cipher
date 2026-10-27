import { db, currentOwner } from '../../db';
import { fromHex, toHex } from './groupCipher';
const ready = () => !!currentOwner();
export async function getGroupKey(groupId, epoch) {
  if (!ready()) return null;
  const row = await db.groupKeys.where('[groupId+epoch]').equals([groupId, epoch]).first();
  return row ? fromHex(row.keyHex) : null;
}
export async function getCurrentGroupKey(groupId) {
  if (!ready()) return null;
  const rows = await db.groupKeys.where('groupId').equals(groupId).toArray();
  if (!rows.length) return null;
  const latest = rows.reduce((a, b) => (a.epoch > b.epoch ? a : b));
  return { epoch: latest.epoch, bytes: fromHex(latest.keyHex), obtainedAt: latest.obtainedAt };
}
export async function getAllGroupKeys(groupId) {
  if (!ready()) return [];
  const rows = await db.groupKeys.where('groupId').equals(groupId).toArray();
  return rows.map(r => ({ epoch: r.epoch, bytes: fromHex(r.keyHex) }));
}
export async function putGroupKey(groupId, epoch, raw, meta = {}) {
  if (!ready()) return;
  const keyHex = toHex(raw);
  await db.transaction('rw', db.groupKeys, async () => {
    // The table's &[groupId+epoch] index is unique and a put without the
    // ++id auto-key inserts — a second write for an epoch the device
    // already holds crashed the install with ConstraintError instead of
    // rewriting the row. Upsert on the pair, and a re-delivery is a
    // rewrite, not a crash. The held obtainedAt survives: re-stating the
    // held epoch must not move the baseline the grant path reads.
    const held = await db.groupKeys.where('[groupId+epoch]').equals([groupId, epoch]).first();
    await db.groupKeys.put({
      groupId,
      epoch,
      keyHex,
      isCurrent: true,
      obtainedAt: held ? held.obtainedAt : Math.floor(Date.now() / 1000),
      ...(held ? { id: held.id } : {}),
      ...meta,
    });
    await db.groupKeys.where('groupId').equals(groupId).modify(row => { if (row.epoch !== epoch) row.isCurrent = false; });
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
