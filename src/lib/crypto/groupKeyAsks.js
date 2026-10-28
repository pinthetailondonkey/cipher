// A key request this device saw and could not answer. The one that matters:
// a member who asked while their join was still pending — the grant path
// refused them on the queue row, correctly — and whose ask would otherwise
// sit unanswered until their own retry ladder comes round again (~30s to the
// first rung), even after the owner approves them.
//
// The ask is remembered whenever a request is seen and not answered, and is
// answered at the approval itself (addMember): the approval drops the queue
// row and names the member on the snapshot, and the standing ask goes out in
// the same click. Every grant rule re-runs at that moment, and the send is
// the same explicit answer a live request gets — the rate window
// (REGRANT_WINDOW_SEC, inside distributeGroupKey) still applies, and the
// asker's own install floor (a device installs only the key it asked for) is
// theirs and untouched.
//
// Per-account scoped storage, like the join queue: the ask has to survive a
// reload to be answered by a later approval.
import { scopedGet, scopedRaw, scopedSet } from '../storage.js';

const KEY = 'gkey_asks';
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
export const ASKS_PER_GROUP_MAX = 200;

function load() {
  const stored = scopedGet(KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function persist(all) {
  scopedSet(KEY, all);
  let landed = false;
  try { landed = scopedRaw(KEY) === JSON.stringify(all); } catch { landed = false; }
  if (!landed) console.error('[group-key] A key ask could not be saved (storage full or blocked); it will not survive a reload.');
  return landed;
}

const cleanId = (value) => String(value || '').trim();
const cleanKey = (value) => String(value || '').trim().toLowerCase();

export function keyAskAt(groupId, pubkey) {
  const at = load()[cleanId(groupId)]?.[cleanKey(pubkey)];
  return Number.isFinite(at) ? at : null;
}

// True when the record changed. The newest ask wins: a relay replaying an
// older request cannot move the ask back in time.
export function rememberKeyAsk(groupId, pubkey, at) {
  const id = cleanId(groupId);
  const who = cleanKey(pubkey);
  const when = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.floor(Number(at)) : Math.floor(Date.now() / 1000);
  if (!id || !HEX_PUBKEY.test(who) || !when) return false;
  const all = load();
  const rows = { ...(all[id] || {}) };
  if (rows[who] >= when) return false;
  rows[who] = when;
  const keys = Object.keys(rows);
  if (keys.length > ASKS_PER_GROUP_MAX) {
    keys.sort((a, b) => rows[a] - rows[b]).slice(0, keys.length - ASKS_PER_GROUP_MAX).forEach((drop) => { delete rows[drop]; });
  }
  all[id] = rows;
  return persist(all);
}

// The ask was answered; it does not fire again on a later approval.
export function clearKeyAsk(groupId, pubkey) {
  const id = cleanId(groupId);
  const who = cleanKey(pubkey);
  const all = load();
  if (!Number.isFinite(all[id]?.[who])) return false;
  const rows = { ...(all[id]) };
  delete rows[who];
  if (Object.keys(rows).length) all[id] = rows;
  else delete all[id];
  return persist(all);
}

// The pure decision for the approval moment: a standing ask, a key this
// device holds, and the grant decision re-run after the approval dropped
// every wall. All three, or nothing sends — a refusal leaves the ask
// standing for the member's own retry to answer.
export function approvalKeySend({ askedAt, hasKey, decision } = {}) {
  if (!Number.isFinite(askedAt) || askedAt <= 0) return { send: false, reason: 'no-ask' };
  if (!hasKey) return { send: false, reason: 'no-key' };
  if (decision !== 'allow') return { send: false, reason: decision || 'refused' };
  return { send: true };
}
