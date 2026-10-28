// Pending group-join requests: one row per kind 9021 sender who was not
// already on the member snapshot. The owner approves or denies each row;
// nothing auto-adds a first-time sender any more.
//
// The queue lives in per-account scoped storage. A request that lands while
// the phone is closed must still be here when the owner opens the app —
// state kept only in memory dies on reload, and no history fetch can carry
// it back.
import { scopedGet, scopedRaw, scopedSet } from './storage.js';

const KEY = 'join_pending';
const DENIED_KEY = 'join_denied';
export const JOIN_REQUESTS_EVENT = 'cipher:join-requests';

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

// Audit finding: any sender can mint a 9021 under a fresh key, so the queue
// and the deny list grew without limit inside one localStorage drawer. The
// caps are generous for a real group and finite for a flood. Pending drops
// the OLDEST row first (the newest request is the one the owner has not yet
// seen); a deny list drops its oldest record first, and is sized so that
// reaching the cap takes far more than any honest history.
export const PENDING_PER_GROUP_MAX = 200;
export const PENDING_TOTAL_MAX = 1000;
export const DENIED_PER_GROUP_MAX = 2000;

// scopedSet swallows a refused write (a full drawer) and keeps the value in
// memory, which a reload then loses. The queue is the owner's only record of
// who asked, so a write is checked by reading the bytes back, and a write
// that did not land is reported, not hidden.
function persist(key, value) {
  scopedSet(key, value);
  let landed = false;
  try { landed = scopedRaw(key) === JSON.stringify(value); } catch { landed = false; }
  if (!landed) console.error(`[join-queue] ${key} could not be saved (storage full or blocked); the change will not survive a reload.`);
  return landed;
}

export function capPending(all) {
  const next = {};
  let total = 0;
  for (const [id, rows] of Object.entries(all || {})) {
    if (!Array.isArray(rows) || !rows.length) continue;
    next[id] = rows.length > PENDING_PER_GROUP_MAX ? rows.slice(-PENDING_PER_GROUP_MAX) : rows;
    total += next[id].length;
  }
  if (total > PENDING_TOTAL_MAX) {
    const flat = Object.entries(next).flatMap(([id, rows]) => rows.map((row) => ({ id, row })));
    flat.sort((a, b) => (a.row.at || 0) - (b.row.at || 0));
    const drop = new Set(flat.slice(0, total - PENDING_TOTAL_MAX).map((item) => item.row));
    for (const id of Object.keys(next)) {
      next[id] = next[id].filter((row) => !drop.has(row));
      if (!next[id].length) delete next[id];
    }
  }
  return next;
}

export function capDenied(rows) {
  const entries = Object.entries(rows || {});
  if (entries.length <= DENIED_PER_GROUP_MAX) return rows;
  entries.sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0));
  return Object.fromEntries(entries.slice(entries.length - DENIED_PER_GROUP_MAX));
}

export function loadPendingJoins() {
  const stored = scopedGet(KEY, {});
  return stored && typeof stored === 'object' ? stored : {};
}

export function pendingJoinsFor(groupId) {
  const rows = loadPendingJoins()[groupId];
  return Array.isArray(rows) ? rows : [];
}

// True the first time this pubkey is queued for the group; false on a repeat,
// so one sender reissuing 9021 cannot stack rows.
export function queuePendingJoin(groupId, { pubkey, eventId, at } = {}) {
  const id = String(groupId || '').trim();
  const who = String(pubkey || '').toLowerCase();
  if (!id || !HEX_PUBKEY.test(who)) return false;
  if (isJoinDenied(id, who)) return false;
  const all = loadPendingJoins();
  const rows = Array.isArray(all[id]) ? all[id] : [];
  if (rows.some((row) => row.pubkey === who)) return false;
  const seconds = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.floor(Number(at)) : Math.floor(Date.now() / 1000);
  all[id] = [...rows, { pubkey: who, eventId: String(eventId || ''), at: seconds }];
  const saved = persist(KEY, capPending(all));
  notifyJoinRequests();
  return saved;
}

export function dropPendingJoin(groupId, pubkey) {
  const id = String(groupId || '').trim();
  if (!id || !pubkey) return false;
  const all = loadPendingJoins();
  const rows = Array.isArray(all[id]) ? all[id] : [];
  const next = rows.filter((row) => row.pubkey !== pubkey);
  if (next.length === rows.length) return false;
  if (next.length) all[id] = next;
  else delete all[id];
  persist(KEY, all);
  notifyJoinRequests();
  return true;
}

// The grant path reads the queue too (drill round D1-B/D1-D). A sender
// still holding a pending row has never been approved by anyone: a open-join
// relay writing them into its next 39002 used to let the grant path hand
// them a key the moment a read succeeded — the queue row outvotes the
// roster here, exactly like the deny list already does.
export function hasPendingJoin(groupId, pubkey) {
  const who = String(pubkey || '').toLowerCase();
  return Boolean(who) && pendingJoinsFor(groupId).some((row) => row.pubkey === who);
}

// The re-add contract above ("a denied sender comes back only through an
// owner-initiated add") was unreachable — nothing cleared the deny, so an
// owner who deliberately re-added a member still could never grant them
// keys (drills D1-E, and it is the way back after a kick). Owner action
// clears it; the relay's word never does.
export function clearJoinDenial(groupId, pubkey) {
  const id = String(groupId || '').trim();
  const who = String(pubkey || '').toLowerCase();
  if (!id || !HEX_PUBKEY.test(who)) return false;
  const all = loadDenied();
  const rows = all[id] || {};
  if (!rows[who]) return false;
  delete rows[who];
  if (Object.keys(rows).length) all[id] = rows;
  else delete all[id];
  persist(DENIED_KEY, all);
  notifyJoinRequests();
  return true;
}

export function notifyJoinRequests() {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(JOIN_REQUESTS_EVENT));
  } catch { /* no window during a test */ }
}

export function subscribeJoinRequests(listener) {
  if (typeof window === 'undefined' || typeof listener !== 'function') return () => {};
  window.addEventListener(JOIN_REQUESTS_EVENT, listener);
  return () => window.removeEventListener(JOIN_REQUESTS_EVENT, listener);
}

// Denial is durable: the relay replays the original 9021 for days, so a row
// dropped on deny would re-queue the same sender on every app open. A denied
// pubkey is recorded per group and the 9021 handler checks it before queueing.
// A denied sender comes back only through an owner-initiated add.
function loadDenied() {
  const stored = scopedGet(DENIED_KEY, {});
  return stored && typeof stored === 'object' ? stored : {};
}

export function deniedJoinsFor(groupId) {
  const rows = loadDenied()[groupId];
  return rows && typeof rows === 'object' ? rows : {};
}

export function isJoinDenied(groupId, pubkey) {
  const id = String(groupId || '').trim();
  const who = String(pubkey || '').toLowerCase();
  if (!id || !HEX_PUBKEY.test(who)) return false;
  return Boolean(deniedJoinsFor(id)[who]);
}

export function denyPendingJoin(groupId, pubkey) {
  const id = String(groupId || '').trim();
  const who = String(pubkey || '').toLowerCase();
  if (!id || !HEX_PUBKEY.test(who)) return false;
  const all = loadDenied();
  const rows = all[id] || {};
  if (rows[who]) return false;
  all[id] = capDenied({ ...rows, [who]: Math.floor(Date.now() / 1000) });
  const saved = persist(DENIED_KEY, all);
  dropPendingJoin(id, who);
  notifyJoinRequests();
  return saved;
}

// A deny must survive the relay's own word. An open-join relay writes the
// 9021 sender back into its next 39002 snapshot, so the owner's account
// strips denied pubkeys from a relay roster before it is stored or used to
// grant keys. Rows arrive as { pubkey, role } objects or plain pubkey
// strings — the two shapes member snapshots already take.
function memberPubkey(row) {
  return String((typeof row === 'string' ? row : row?.pubkey) || '');
}

export function withoutDenied(groupId, rows) {
  const id = String(groupId || '').trim();
  if (!id || !Array.isArray(rows)) return rows || [];
  return rows.filter((row) => !isJoinDenied(id, memberPubkey(row)));
}

// Audit finding: a relay-signed 39002 that names someone the owner never
// approved used to land on the owner's stored roster whole, and the later
// 9021 from that stranger then read "already a member" and skipped the
// approval queue — the roster the relay wrote outvoted the owner.
//
// On the group owner's device the stored roster is the owner's own ledger
// (creation, owner adds, kicks), so a relay roster may carry names that
// ledger already holds and may drop names, but a NEW name is a request, not
// a member: it is split out here to join the pending queue and does not land
// on the roster until the owner approves it (addMember). Two cases pass
// everything through, because there is no ledger to outvote: a device with
// no stored roster yet (an existing member loading the group on a fresh
// device takes the relay's roster as its baseline, as any member does), and
// any device that is not the owner's, which cannot approve anyone and holds
// the relay's roster as its only evidence of membership.
export function admitRelayRoster({ previous, incoming, isOwner, selfPk = '' } = {}) {
  const rows = Array.isArray(incoming) ? incoming : [];
  if (!isOwner || !Array.isArray(previous)) return { members: rows, unapproved: [] };
  const held = new Set(previous.map((row) => memberPubkey(row).toLowerCase()));
  const me = String(selfPk || '').toLowerCase();
  const members = [];
  const unapproved = [];
  for (const row of rows) {
    const who = memberPubkey(row).toLowerCase();
    if (!who) continue;
    if (who === me || held.has(who)) members.push(row);
    else if (!unapproved.includes(who)) unapproved.push(who);
  }
  return { members, unapproved };
}

// The order the 9021 handler decides in, as one pure function. Presence in
// the stored roster is the LAST test, never the first: a sender the owner
// denied or still has pending is not a member whatever a roster says, and
// only a sender with no standing either way and already on the roster is a
// known member re-stating a join. Everyone else is a request.
//   self   - this device's own join echo
//   ignore - denied, or already waiting in the queue
//   deny   - joins are off (the Groups setting is Nobody)
//   known  - a member of record re-stating a join (no queue, no change)
//   queue  - a request for the owner
export function joinRequestDecision({ isSelf, denied, pending, allowsJoins, inSnapshot } = {}) {
  if (isSelf) return 'self';
  if (denied || pending) return 'ignore';
  if (!allowsJoins) return 'deny';
  return inSnapshot ? 'known' : 'queue';
}
