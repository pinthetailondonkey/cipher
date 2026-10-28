// Who was removed from a group, and when. A member who is kicked, or who leaves,
// keeps the key to the epochs they held, and a relay that does not check writes
// will take their next message. The receiver therefore has to know the line
// itself: a message the removed member made AFTER their removal is refused, one
// made before it still shows — history from before the kick stays readable.
//
// The line is the created_at of the authorized 9001 (kick) or 9022 (leave) this
// device read. created_at is the sender's own claim, so a removed member who
// back-dates a message past the line gets it through; what that buys them is a
// message that sorts among the old ones, under a key the group has already moved
// off. Only an add made after the removal (an owner's 9000) clears it.
//
// Per-account scoped storage, like the join queue: state kept only in memory
// dies on reload, and a history fetch would bring the removed member's late
// messages straight back.
import { scopedGet, scopedRaw, scopedSet } from './storage.js';

const KEY = 'group_removed';
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
export const REMOVED_PER_GROUP_MAX = 2000;

function load() {
  const stored = scopedGet(KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function persist(all) {
  scopedSet(KEY, all);
  let landed = false;
  try { landed = scopedRaw(KEY) === JSON.stringify(all); } catch { landed = false; }
  if (!landed) console.error('[group-removal] The removal record could not be saved (storage full or blocked); it will not survive a reload.');
  return landed;
}

const cleanId = (value) => String(value || '').trim();
const cleanKey = (value) => String(value || '').trim().toLowerCase();
const cleanAt = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

export function removalAt(groupId, pubkey) {
  const at = load()[cleanId(groupId)]?.[cleanKey(pubkey)];
  return Number.isFinite(at) ? at : null;
}

// True when the record changed. The newest removal wins: a replayed older
// kick cannot move the line back.
export function recordMemberRemoval(groupId, pubkey, at) {
  const id = cleanId(groupId);
  const who = cleanKey(pubkey);
  const when = cleanAt(at);
  if (!id || !HEX_PUBKEY.test(who) || !when) return false;
  const all = load();
  const rows = { ...(all[id] || {}) };
  if (rows[who] >= when) return false;
  rows[who] = when;
  const keys = Object.keys(rows);
  if (keys.length > REMOVED_PER_GROUP_MAX) {
    keys.sort((a, b) => rows[a] - rows[b]).slice(0, keys.length - REMOVED_PER_GROUP_MAX).forEach((drop) => { delete rows[drop]; });
  }
  all[id] = rows;
  return persist(all);
}

// Only an add made at or after the removal brings the member back; an older
// add replayed by a relay does not.
export function clearMemberRemoval(groupId, pubkey, addedAt) {
  const id = cleanId(groupId);
  const who = cleanKey(pubkey);
  const all = load();
  const at = all[id]?.[who];
  if (!Number.isFinite(at)) return false;
  if (cleanAt(addedAt) < at) return false;
  const rows = { ...all[id] };
  delete rows[who];
  if (Object.keys(rows).length) all[id] = rows;
  else delete all[id];
  return persist(all);
}

// True when this sender was removed and the message is stamped after the line.
export function sentAfterRemoval(groupId, pubkey, createdAt) {
  const at = removalAt(groupId, pubkey);
  const made = Number(createdAt);
  return at !== null && Number.isFinite(made) && made > at;
}
