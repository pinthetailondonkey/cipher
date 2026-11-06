// The member-set document on the wire and at rest (Step 1c, MEMBERSHIP-DESIGN.md).
//
// Publish: a parameterized replaceable kind 30079 under d = cipher-gmemdoc:<gid>,
// signed by the per-group authority key (groupAuthority.js), content sealed
// with the group's own crypto so the roster of a private group does not
// become public text where its chat is not.
//
// The rules this file hard-codes, so no caller can route around them:
//   H2  gen decides at rest; created_at is stamped max(prev+1, now) only to
//       satisfy replaceable semantics, never to decide anything.
//   H4  a doc once held at generation G can be replaced at rest only by a
//       VERIFIED doc with gen > G. A failed verification or an equal/lower
//       generation cannot demote it. "No doc found" stays refuse for callers.
//   H6  dual publish: group relays + general relays. Two boxes share one
//       operator (the group relay operator also runs a media host), so the
//       general-relay mirror is the cross-operator copy, which is why it
//       matters that memberBaseline already put similar data there.

import { finalizeEvent } from 'nostr-tools';
import { db } from '../../db';
import { canonicalBody } from './groupDoc.js';
import { deriveDocAesInput, normalizeDocKey } from './groupDocKey';

export const MEMBER_DOC_KIND = 30079;
export const MEMBER_DOC_D_PREFIX = 'cipher-gmemdoc';

export function memberDocTag(groupId) {
  return `${MEMBER_DOC_D_PREFIX}:${groupId}`;
}

async function importAesKey(raw, uses) {
  return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, uses);
}

// The content key derives from pin+gid (what every invite-holder knows)
// rather than from any relay-fetchable value. Not a secret against a member,
// who legitimately reads this; it is a curtain between the relay and the
// body of a private group's governance record.
async function docContentKey(pin, groupId) {
  const material = new TextEncoder().encode(`cipher-gmemdoc-key-v1:${String(pin || '').toLowerCase()}:${groupId}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  return new Uint8Array(digest);
}

// The content key for envelope version 2 is HKDF over the group's governance
// doc key (SEC-1): a random per-group secret created at genesis, shared only
// through the sealed gkey-bundle riders, rotated wherever chat epochs rotate.
// Version 1 keeps the old pin+gid derivation as a DECODE-ONLY fallback for
// events already on relays when this remediation lands — a device with no
// legacy knowledge (never derivable except from an invite link) still opens
// them, but every NEW seal uses v2.
const ENVELOPE_V1_AAD_PREFIX = 'cipher-gmemdoc-v1|';
const ENVELOPE_V2_AAD_PREFIX = 'cipher-gmemdoc-v2|';

function senderAad(version, groupId, _epochUnused = undefined) {
  const prefix = version === 2 ? ENVELOPE_V2_AAD_PREFIX : ENVELOPE_V1_AAD_PREFIX;
  return new TextEncoder().encode(`${prefix}${groupId}`);
}

// Seal under the held governance-doc key (v2, SEC-1). When no doc key is held
// this DEGRADES to the legacy pin+gid derivation so a creator's very first
// genesis doc still publishes before any member holds the v2 secret; the
// bootstrapping ride then delivers it. `docKey` may be raw bytes or hex.
// Note: version 2 binds NO epoch counter into its AAD - the secret itself
// rotates, so the key material is the truth and a publish racing a rotation
// can never desynchronize from its own envelope fields.
export async function sealDocBody(signed, pin, groupId, docKey = null) {
  if (!signed || !signed.id || !signed.sig || !signed.body) return null;
  const normalized = normalizeDocKey(docKey);
  const version = normalized ? 2 : 1;
  const aesInput = version === 2
    ? await deriveDocAesInput(normalized)
    : await docContentKey(pin, groupId);
  if (!aesInput) return null;
  const key = await importAesKey(aesInput, ['encrypt']);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify({ id: signed.id, sig: signed.sig, body: signed.body }));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: senderAad(version, groupId) },
    key,
    plaintext,
  );
  // Reuse groupCipher's envelope shape (v/iv/ct b64) without dragging its
  // epoch/sender AAD semantics here — those bind to chat key epochs.
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
  return JSON.stringify({ v: version, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
}

async function importAesDecryptKey(raw) {
  return importAesKey(raw, ['decrypt']);
}

export async function openSealedDocBody(contentJson, pin, groupId, docKey = null) {
  let envelope;
  try {
    envelope = typeof contentJson === 'string' ? JSON.parse(contentJson) : contentJson;
  } catch {
    return null;
  }
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') return null;
  if (envelope.v !== 1 && envelope.v !== 2) return null;
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  // Candidate order for ANY envelope version: the held governance-doc key
  // first (a v2 body opens only this way, and a stale-held reader simply
  // misses until its bundle rides in), then the legacy pin+gid derivation
  // for every v1-era body already on relays - including a creator's genesis
  // doc sealed v1 in the seconds before its own bundle went out.
  const candidates = [];
  if (normalizeDocKey(docKey)) candidates.push(await deriveDocAesInput(docKey));
  candidates.push(await docContentKey(pin, groupId));
  for (const aesInput of candidates) {
    if (!aesInput) continue;
    try {
      const key = await importAesDecryptKey(aesInput);
      const pt = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: senderAad(envelope.v, groupId) },
        key,
        unb64(envelope.ct),
      );
      const parsed = JSON.parse(new TextDecoder().decode(pt));
      return parsed && parsed.id && parsed.sig && parsed.body ? parsed : null;
    } catch { /* next candidate */ }
  }
  return null;
}

// Build the wire event. `createdAt` arrives stamped by the caller (H2:
// max(prev.created_at + 1, now)); passing it in keeps the stamp rule testable
// against fixed clocks instead of buried next to Date.now().
export async function buildMemberDocEvent({ signedDoc, authoritySk, pin, groupId, createdAt, docKey = null }) {
  if (!authoritySk || !(authoritySk instanceof Uint8Array) || authoritySk.length !== 32) return null;
  const canonical = canonicalBody(signedDoc?.body || signedDoc);
  if (!canonical || !Number.isInteger(Number(createdAt))) return null;
  const ciphertext = await sealDocBody(signedDoc, pin, groupId, docKey);
  if (!ciphertext) return null;
  return finalizeEvent({
    kind: MEMBER_DOC_KIND,
    created_at: Number(createdAt),
    tags: [['d', memberDocTag(groupId)]],
    content: ciphertext,
  }, authoritySk);
}

// ── At rest (H2/H4 as storage law) ─────────────────────────────────────────

// Test seam: same pattern groupKeyRotation uses for groupMemberSigs.
let docsDb = null;
export function __setDocsDbForTests(next) { docsDb = next || null; }
const docsTable = () => (docsDb || db).groupMemberDocs;

// Verify against the out-of-band pin, then store. A doc at equal gen with the
// same id is idempotent noise from a second relay answering twice. Equal gen
// with a DIFFERENT id is an H9 conflict pair: both are stored (the reconciler
// heals), neither overwrites the other.
export async function rememberVerifiedDoc({ groupId, pin, signed }) {
  const opened = await verifyAgainstPin({ pin, signed });
  if (!opened) return null;
  // `opened` is the verified body carrying its recomputed id; pass it under
  // the wrapper shape storeVerifiedDocRow expects.
  return storeVerifiedDocRow({ groupId, signed: { id: opened.id, sig: signed?.sig || '', body: opened } });
}

export async function verifyAgainstPin({ pin, signed }) {
  const { verifySignedDoc } = await import('./groupDoc.js');
  return verifySignedDoc({ signed, pin });
}

async function storeVerifiedDocRow({ groupId, signed }) {
  const canonical = canonicalBody(signed.body);
  if (!canonical) return null;
  try {
    const existing = await docsTable().get([groupId, canonical.gen]);
    if (existing && existing.docId !== signed.id) {
      // Conflict pair at this generation: keep both under their ids.
      await docsTable().put({
        groupId, gen: canonical.gen, docId: signed.id, doc: signed, updatedAt: Math.floor(Date.now() / 1000),
      });
      return { stored: true, conflictWith: existing };
    }
    await docsTable().put({
      groupId, gen: canonical.gen, docId: signed.id, doc: signed, updatedAt: Math.floor(Date.now() / 1000),
    });
    return { stored: true };
  } catch {
    return null;
  }
}

// Heads read: highest gens first, with any distinct-id docs at the top gen
// surfaced as conflicts for healHeads. Gen decides ordering (H2 at rest).
export async function loadMemberDocHeads(groupId, { limit = 5 } = {}) {
  try {
    const rows = await docsTable()
      .where('groupId').equals(groupId)
      .toArray();
    if (!rows.length) return [];
    rows.sort((a, b) => b.gen - a.gen || String(a.docId).localeCompare(String(b.docId)));
    const topGen = rows[0].gen;
    const heads = rows.filter((row) => row.gen >= Math.max(topGen - limit + 1, 0));
    return heads.map((row) => ({ ...row.doc, _gen: row.gen }));
  } catch {
    return [];
  }
}

// ── Receive: a relayed doc event becomes an at-rest verified row ──────────
// The door the publish side has been missing on purpose (Step 1c landed wire
// and store; this is the third piece). The event's OWN author is not believed:
// the signature verifies against the OUT-OF-BAND pin this device holds (H5),
// so a relay inventing events or a stranger publishing under any key reads
// nothing. Content is sealed under pin+gid, which doubles as the gid binding.

// One wire event → {stored, opened} or null. Every refusal is quiet-by-design:
// a wrong-pin or foreign-key doc is relay noise, not an error to surface, and
// the caller answers from whatever heads it already holds (H4's null path).
export async function ingestMemberDocEvent(event, { pin, groupId, docKey = null }) {
  if (!event || event.kind !== MEMBER_DOC_KIND) return null;
  if (!pin || !groupId) return null;
  // SEC-1: resolve this device's held governance-doc key here so every
  // receiving path (live subscription, catch-up refresh) opens under it;
  // without one the legacy candidates still decode pre-remediation events.
  // An explicitly passed docKey wins over the store read.
  let heldDocKey = normalizeDocKey(docKey);
  if (!heldDocKey) {
    try {
      const { getDocKey } = await import('./groupKeyStore');
      heldDocKey = (await getDocKey(groupId))?.bytes || null;
    } catch { /* no store available: legacy candidates only */ }
  }
  const dTag = (event.tags || []).find((tag) => tag[0] === 'd')?.[1] || '';
  if (dTag !== memberDocTag(groupId)) return null;
  // The pin itself names this group's authority key only when the event was
  // authored by its x-only form: the publish side signs with that same key,
  // so a mismatching author fails verification below anyway — but checking
  // first keeps a random stranger's event from even reaching AES work.
  const xonly = String(pin).toLowerCase();
  const compact = /^[0-9a-f]{66}$/.test(xonly) ? xonly.slice(2) : xonly;
  if (String(event.pubkey || '').toLowerCase() !== compact) return null;
  const signed = await openSealedDocBody(event.content, pin, groupId, heldDocKey);
  if (!signed) return null;
  return rememberVerifiedDoc({ groupId, pin, signed });
}

