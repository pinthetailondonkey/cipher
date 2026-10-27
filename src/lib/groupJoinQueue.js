// Pending group-join requests: one row per kind 9021 sender who was not
// already on the member snapshot. The owner approves or denies each row;
// nothing auto-adds a first-time sender any more.
//
// The queue lives in per-account scoped storage. A request that lands while
// the phone is closed must still be here when the owner opens the app —
// state kept only in memory dies on reload, and no history fetch can carry
// it back.
import { scopedGet, scopedSet } from './storage.js';

const KEY = 'join_pending';
const DENIED_KEY = 'join_denied';
export const JOIN_REQUESTS_EVENT = 'cipher:join-requests';

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

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
  scopedSet(KEY, all);
  notifyJoinRequests();
  return true;
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
  scopedSet(KEY, all);
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
  scopedSet(DENIED_KEY, all);
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
  all[id] = { ...rows, [who]: Math.floor(Date.now() / 1000) };
  scopedSet(DENIED_KEY, all);
  dropPendingJoin(id, who);
  notifyJoinRequests();
  return true;
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
