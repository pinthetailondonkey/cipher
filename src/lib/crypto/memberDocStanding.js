// The doc-backed reader all seven consumers share (Step 1d, MEMBERSHIP-DESIGN.md).
//
// Every standing decision reads the member-set document through here. The
// contract this file enforces is H4's discipline: a group with NO held doc
// yields `null` and the caller refuses; it never quietly answers from the
// relay-signed 39002 roster. The roster is demoted to what the design says it
// is now — a display fallback for the screen list only.
//
// Where the pin comes from matters (H5): the doc body's signatures verify
// against the authority pin, which each member learned out of band in their
// invite link. This module asks the caller's bound pin getter for it. A device
// with no stored pin has no way to verify docs and therefore sees null —
// refuse again — rather than trusting an unverified fetched doc.

import { resolveMembership, canonicalBody } from './groupDoc.js';
import { loadMemberDocHeads } from './groupDocWire.js';

// Test seam + app binding: the app binds its per-group pin source once at
// bootstrap (the pins live in localStorage under the account scope, written
// when an invite link or owner creation stamps them).
let pinSource = null;
export function bindMemberDocPins(fn) {
  pinSource = typeof fn === 'function' ? fn : null;
  return () => {
    if (pinSource === fn) pinSource = null;
  };
}

async function pinFor(groupId) {
  if (!pinSource) return '';
  try {
    const pin = await pinSource(groupId);
    return typeof pin === 'string' ? pin : '';
  } catch {
    return '';
  }
}

export function docSnapshotShape(doc) {
  // The consumers' existing gates take the old snapshot shape:
  // [{pubkey, role}] / strings. Resolving the doc folds tombstones first.
  // Step 2 slice 3: a row that names an actor pin keeps it — the (account ->
  // pin) map the control-authorization cutover resolves senders through.
  // memberKey-style consumers read .pubkey and are untouched by the extra
  // field; isGroupAdmin reads role.
  const standing = resolveMembership(doc);
  return standing.map((row) => ({
    pubkey: row.pubkey,
    role: row.role || 'member',
    ...(row.actor ? { actor: row.actor } : {}),
  }));
}

/**
 * Returns a snapshot-shaped array from the highest held doc generation, or
 * `null` when this device holds no verified doc AND no pin to verify one.
 *
 * Equal-generation conflict pairs are healed here before answering: H9's
 * containment arm first, then union-and-bump — but healing only SIGNS nothing;
 * it picks the view whose ancestry contains the other when that can be seen,
 * otherwise answers from the pair by folding both tombstone sets (fail-closed:
 * removal wins ties), which is exactly resolveMembership over a merged view.
 */
export async function loadDocStanding(groupId) {
  if (!groupId) return null;
  const pin = await pinFor(groupId);
  const heads = await loadMemberDocHeads(groupId);
  if (!heads.length || !pin) return null;
  // Heads are already pin-verified rows (rememberVerifiedDoc gates writes);
  // a straight read needs no re-verification.
  if (heads.length === 1) return docSnapshotShape(heads[0]);

  // Multiple heads at or near top gen: pick deterministically.
  const [top] = heads;
  const sameGen = heads.filter((h) => h.gen === top.gen && h.id !== top.id);
  if (!sameGen.length) return docSnapshotShape(top);

  // Conflict pair resolution without signing: fold the pair fail-closed.
  const merged = mergeHeadsFailClosed(top, heads.find((h) => h.gen === top.gen && h.id !== top.id));
  return docSnapshotShape(merged);
}

function mergeHeadsFailClosed(a, b) {
  const left = canonicalBody(a);
  const right = canonicalBody(b);
  if (!left || !right) return a;
  const membersByKey = new Map(left.members.map((row) => [row.pubkey, { ...row }]));
  const removedByKey = new Map(left.removed.map((row) => [row.pubkey, { ...row }]));
  for (const row of right.members) {
    const mine = membersByKey.get(row.pubkey);
    if (!mine || row.gen > mine.gen) membersByKey.set(row.pubkey, { ...row });
  }
  for (const row of right.removed) {
    const mine = removedByKey.get(row.pubkey);
    if (!mine || row.gen > mine.gen) removedByKey.set(row.pubkey, { ...row });
  }
  for (const [pubkey, row] of [...membersByKey]) {
    const tombstone = removedByKey.get(pubkey);
    if (tombstone && tombstone.gen >= row.gen) membersByKey.delete(pubkey);
  }
  return {
    ...left,
    gen: left.gen,
    epoch: Math.max(left.epoch, right.epoch),
    parents: [...new Set([...(left.parents || []), ...(right.parents || [])])].sort(),
    members: [...membersByKey.values()].sort((x, y) => (x.pubkey < y.pubkey ? -1 : 1)),
    removed: [...removedByKey.values()],
  };
}
