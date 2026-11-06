// The owner-signed member-set document (docs/MEMBERSHIP-DESIGN.md, Step 1).
//
// This file is the pure core: shapes, canonical hashing, signing/verifying,
// the gen-over-created_at rule and the H9 healing. No relay, no DB here.
// Everything in it is a decision that tests witness directly; the wire path
// (publish/read) and the seven consumers are separate pieces of work.
//
// H-rule map, so an audit can walk from rule to line:
//   H1(b) tombstones        — memberRow gen / resolveMembership /
//                             removedEntry / applyDocOps
//   H2  gen over created_at — compareDocs: gen wins; created_at never decides
//   H3  epoch binding       — docEpoch / grantPermittedByDoc
//   H4  refuse-not-fallback — callers' contract: no doc means refuse. Enforced
//                             by the shape of these returns (null), never
//                             papered over by a roster read here.
//   H9  parents as frontier; union-and-bump heal; canonical core so two
//       devices merging the same heads emit byte-identical docs.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX66 = /^[0-9a-f]{66}$/;

export const DOC_T = 'gmemdoc';
export const DOC_V = 1;

function normalizePubkey(value) {
  const text = String(value || '').toLowerCase();
  return HEX64.test(text) ? text : '';
}

// A member row carries the generation that admitted it, so a tombstone at a
// higher generation beats it without any clock (H1(b): the entry's own `gen`).
export function memberRow(row) {
  if (!row) return null;
  const pubkey = normalizePubkey(typeof row === 'string' ? row : row?.pubkey);
  if (!pubkey) return null;
  const role = row && typeof row === 'object' && typeof row.role === 'string' && row.role
    ? row.role : 'member';
  const gen = Number.isInteger(Number(row?.gen)) && Number(row.gen) >= 0 ? Number(row.gen) : null;
  return gen === null ? null : { pubkey, role, gen };
}

export function removedRow(row) {
  if (!row) return null;
  const pubkey = normalizePubkey(typeof row === 'string' ? row : row?.pubkey);
  if (!pubkey) return null;
  const gen = Number.isInteger(Number(row?.gen)) && Number(row.gen) >= 0 ? Number(row.gen) : null;
  return gen === null ? null : { pubkey, gen };
}

function sortRows(rows) {
  // Canonical order is part of the hash (H9(3)): pubkey asc, then gen asc.
  return [...rows].sort((a, b) => (
    a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : a.gen - b.gen
  ));
}

// ── Canonical semantic core ────────────────────────────────────────────────
// The doc id hashes this, excluding `at` and `created_at`, so two devices that
// merge the same heads at the same generation produce byte-identical docs even
// though their clocks differ. Roles are semantics too and live in the hash:
// an unannounced demotion becomes its own document instead of silence.
export function canonicalBody(doc) {
  // Accepts either a bare canonical body or a signed wrapper ({id, body, ...});
  // call sites hand both shapes through the same door.
  const source = doc && typeof doc === 'object' && doc.body ? doc.body : doc;
  if (!source || typeof source !== 'object') return null;
  const gid = String(source.gid || '').trim();
  const gen = Number(source.gen);
  const epoch = Number(source.epoch);
  if (!gid || !Number.isInteger(gen) || gen < 0 || !Number.isInteger(epoch) || epoch < 0) return null;
  const parents = [...new Set((Array.isArray(source.parents) ? source.parents : [])
    .map((id) => String(id || '').toLowerCase()).filter((id) => HEX64.test(id)))].sort();
  const members = sortRows((Array.isArray(source.members) ? source.members : [])
    .map(memberRow).filter(Boolean))
    .map((row) => ({ ...row }));
  const removed = sortRows((Array.isArray(source.removed) ? source.removed : [])
    .map(removedRow).filter(Boolean))
    .map((row) => ({ ...row }));
  // Genesis is the one document with no parent; after it, parents are
  // mandatory and `docComplete` says whether they are all held.
  return { v: DOC_V, t: DOC_T, gid, gen, epoch, parents, members, removed };
}

export async function docIdOf(canonical) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(digest));
}

function hexToBytesStrict(value) {
  // Even-length hex of any size: 64-char digests, 128-char signatures and
  // 66-char pins all pass; odd length or non-hex does not.
  const text = String(value || '').toLowerCase();
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/.test(text)) throw new Error('bad hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Sign with the per-group authority key derived from the account key (Step 0
// decision). What leaves this device: the signed event only. The body hashed
// is the canonical one, not the wire JSON, so `verifySignedDoc` can recompute
// the same digest from any semantically equal copy that arrives re-ordered.
export async function signDocEvent(body, privateKeyBytes, { at = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.length !== 32) return null;
    const canonical = canonicalBody(body);
    if (!canonical) return null;
    const digest = await docIdOf(canonical);
    const message = hexToBytesStrict(digest);
    // prehash:false on both sides (the escrowPsbt pattern): the digest is the
    // message, not an input to another hash. lowS keeps signatures canonical.
    const signature = secp256k1.sign(message, privateKeyBytes, { prehash: false });
    const signed = {
      id: digest,
      body: canonical,
      at,
      sig: bytesToHex(signature),
    };
    const pin = authorityPinOf(privateKeyBytes);
    const verified = await verifySignedDoc({ signed, pin });
    if (!verified) return null;
    return signed;
  } catch {
    return null;
  }
}

export function authorityPinOf(privateKeyBytes) {
  if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.length !== 32) return '';
  // The pin is the compressed pubkey. nostr's own x-only pins differ by two
  // bytes; this one is checked with noble directly, so compression is kept.
  return bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
}

// Verify against a pin learned out of band through the invite link (H5),
// never against something fetched from a relay row.
export async function verifySignedDoc({ signed, pin }) {
  try {
    if (!signed || typeof signed !== 'object') return null;
    const pinnedHex = String(pin || '').toLowerCase().trim();
    if (!HEX66.test(pinnedHex)) return null;
    const sigOk = secp256k1.verify(
      hexToBytesStrict(signed.sig),
      hexToBytesStrict(String(signed.id || '')),
      hexToBytesStrict(pinnedHex),
      { prehash: false },
    );
    if (!sigOk) return null;
    const canonical = canonicalBody({ ...signed.body });
    if (!canonical) return null;
    const recomputed = await docIdOf(canonical);
    if (recomputed !== signed.id) return null;
    return { ...signed.body, id: signed.id };
  } catch {
    return null;
  }
}

// Genesis: first doc of a group, no parent, generation 0.
export async function genesisDocBody({ gid, epoch, members }) {
  return canonicalBody({
    gid,
    gen: 0,
    epoch,
    parents: [],
    members: (members || []).map((pubkey) => ({
      pubkey, role: 'member', gen: 0,
    })),
    removed: [],
  });
}

// The next body on top of an observed head (or several, when healing):
// union members (kept rows keep their admitting gen; same-pubkey merges take
// the higher gen and the standing role), clear the tombstones this doc's
// members re-admit at or above their removal gen, add new admits at the new
// gen. Deterministic because the ops are deterministic (H9 merge note).
export function applyDocOps(headCanonical, { admit = [], remove = [], demote = [], promote = [], gen }) {
  const head = canonicalBody(headCanonical);
  if (!head || !Number.isInteger(gen) || gen <= head.gen) return null;
  const membersByKey = new Map(head.members.map((row) => [row.pubkey, { ...row }]));
  const removedByKey = new Map(head.removed.map((row) => [row.pubkey, { ...row }]));
  for (const entry of admit) {
    const pubkey = normalizePubkey(typeof entry === 'string' ? entry : entry?.pubkey);
    if (!pubkey) continue;
    membersByKey.set(pubkey, { pubkey, role: 'member', gen });
    // An admit clears the tombstone only when it answers it (H1(b)): a removal
    // recorded at gen R survives unless someone deliberately re-admits at >= R.
    const tombstone = removedByKey.get(pubkey);
    if (tombstone && gen >= tombstone.gen) removedByKey.delete(pubkey);
  }
  for (const entry of remove) {
    const pubkey = normalizePubkey(entry);
    if (!pubkey) continue;
    membersByKey.delete(pubkey);
    removedByKey.set(pubkey, { pubkey, gen });
  }
  for (const entry of demote) {
    const pubkey = normalizePubkey(entry);
    const row = membersByKey.get(pubkey);
    if (row && row.role !== 'member') membersByKey.set(pubkey, { ...row, role: 'member' });
  }
  for (const entry of promote) {
    const pubkey = normalizePubkey(entry);
    const row = membersByKey.get(pubkey);
    if (row && row.role !== 'admin') membersByKey.set(pubkey, { ...row, role: 'admin' });
  }
  return canonicalBody({
    gid: head.gid,
    gen,
    epoch: head.epoch,
    parents: [head.id || ''].filter(Boolean),
    members: [...membersByKey.values()],
    removed: [...removedByKey.values()],
  });
}

// H9 healing over a pair of same-generation heads. Rule order is normative:
// (a) containment wins by ancestry — but ancestry means "its parent set names
// the other", checked directly between these two heads (and transitively once
// callers hold full sets); (b) otherwise both fold into one doc: union of
// members, union of removed minus a re-admit settled by tombstone-vs-entry
// gen, parents naming BOTH heads, bumped to gen+1. Two devices doing this
// simultaneously emit identical bodies, because everything merged is sorted
// canonically and the bump count comes off the shared head gen.
export function healHeads({ local, remote }) {
  // Ids are read from the inputs: the canonical body does not carry its own
  // id (the id is derived from the body), so it must not be lost here.
  const localId = typeof local?.id === 'string' ? String(local.id).toLowerCase() : '';
  const remoteId = typeof remote?.id === 'string' ? String(remote.id).toLowerCase() : '';
  const a = canonicalBody(local);
  const b = canonicalBody(remote);
  if (!a || !b) return null;
  if (a.gid !== b.gid) return null;
  if (a.gen !== b.gen) {
    // Not a conflict pair: the lower one is simply stale. Callers compareDocs.
    return null;
  }
  // H9 rule (a): "if one head's ancestry contains the other head, that one
  // wins" — the CONTAINER wins, i.e. the head that has seen more.
  if (remoteId && b.parents.includes(localId)) return { ...canonicalBody(b), id: remoteId };
  if (localId && a.parents.includes(remoteId)) return { ...canonicalBody(a), id: localId };

  const gen = a.gen + 1;
  const membersByKey = new Map(a.members.map((row) => [row.pubkey, { ...row }]));
  const removedByKey = new Map(a.removed.map((row) => [row.pubkey, { ...row }]));

  for (const row of b.members) {
    const mine = membersByKey.get(row.pubkey);
    // Same-pubkey merge takes the higher admitting gen; on a tie the more
    // standing role keeps the doc honest about what each side believed.
    if (!mine || row.gen > mine.gen) membersByKey.set(row.pubkey, { ...row });
    else if (mine.role === 'member' && row.role === 'admin') membersByKey.set(row.pubkey, { ...row });
  }
  for (const row of b.removed) {
    const mine = removedByKey.get(row.pubkey);
    if (!mine || row.gen > mine.gen) removedByKey.set(row.pubkey, { ...row });
  }
  // Tombstone beats a concurrent admit when its removal gen is strictly later
  // than the membership entry's admitting gen (H1(b)). Equal gens mean both
  // sides believed differently at the same point: the tombstone wins, because
  // removal beats admission is the fail-closed direction for key grants.
  for (const [pubkey, row] of [...membersByKey]) {
    const tombstone = removedByKey.get(pubkey);
    if (tombstone && tombstone.gen >= row.gen) {
      membersByKey.delete(pubkey);
    }
  }
  return canonicalBody({
    gid: a.gid,
    gen,
    epoch: Math.max(a.epoch, b.epoch),
    parents: [localId, remoteId].filter(Boolean).sort(),
    members: [...membersByKey.values()],
    removed: [...removedByKey.values()],
  });
}

// ── Reading semantics ──────────────────────────────────────────────────────

// H2 everywhere including at rest: gen decides, created_at never does. A
// refusal to consult created_at is the whole point — a skewed clock cannot
// make the relay drop gen+1 in favour of gen.
export function compareDocs(a, b) {
  const left = canonicalBody(a);
  const right = canonicalBody(b);
  if (!left || !right) return null;
  if (left.gid !== right.gid) return null;
  if (left.gen > right.gen) return left;
  if (left.gen < right.gen) return right;
  // Equal gen, distinct ids = an H9 conflict pair. Same ids = same doc.
  if (left.parents.join() === right.parents.join()
    && JSON.stringify(left.members) === JSON.stringify(right.members)
    && JSON.stringify(left.removed) === JSON.stringify(right.removed)) {
    return canonicalBody(left);
  }
  return { conflict: [left, right], winner: null };
}

// Current membership after folding the tombstones (H1(b)): a row stands only
// while no tombstone at >= its admitting gen exists. Fail-closed ordering.
export function resolveMembership(doc) {
  const canonical = canonicalBody(doc);
  if (!canonical) return [];
  const tombstones = new Map(canonical.removed.map((row) => [row.pubkey, row.gen]));
  return canonical.members
    .filter((row) => {
      const tombstoneGen = tombstones.get(row.pubkey);
      return tombstoneGen === undefined || row.gen > tombstoneGen;
    })
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
}

// H4's positive half: the roster read is display-only. Every consumer here
// takes the doc's resolved list or nothing. There is no third door that
// quietly answers from 39002 when the doc is missing; that choice belongs to
// the caller, and the contract in MEMBERSHIP-DESIGN.md section 6 says refuse.

export function docEpoch(doc) {
  const canonical = canonicalBody(doc);
  return canonical ? canonical.epoch : null;
}

// H3: a grant names `{docId, gen, epochs[]}`. The caller holds the verified
// doc (its id was recomputed by verifySignedDoc); the grant's docId must name
// exactly this doc, its gen may not exceed the doc's, and every epoch it
// offers must be one the named doc authorizes.
export function grantPermittedByDoc({ docId, doc, grant }) {
  const canonical = canonicalBody(doc);
  if (!canonical || !grant || typeof grant !== 'object') return false;
  if (!canonical.parents.length && canonical.gen > 0) return false; // parents mandatory after genesis
  // The grant names the doc the caller verified; both sides of this comparison
  // must be that exact id. A docId that does not name THIS doc is refused even
  // if the grant self-consistently repeats it (H3: a stale doc cannot back a
  // fresh grant).
  if (String(grant.docId || '') !== String(docId || '')) return false;
  if (!Number.isInteger(grant.gen) || grant.gen < 0 || grant.gen > canonical.gen) return false;
  const epochs = Array.isArray(grant.epochs) ? grant.epochs : [];
  if (!epochs.length) return false;
  return Number.isInteger(canonical.epoch)
    && epochs.every((epoch) => Number.isInteger(epoch) && epoch >= 0 && epoch <= canonical.epoch);
}

// Cache the last computed id so repeated comparisons over the same object do
// not re-hash. Keyed by object identity; GC handles it.
const idMemo = new WeakMap();
export async function canonicalId(canonicalBodyOrDoc) {
  const canonical = canonicalBody(canonicalBodyOrDoc);
  if (!canonical) return '';
  const memoized = idMemo.get(canonical);
  if (memoized?.id) return memoized.id;
  const id = await docIdOf(canonical);
  idMemo.set(canonical, { id });
  return id;
}
