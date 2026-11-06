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

function senderAad(groupId) {
  return new TextEncoder().encode(`cipher-gmemdoc-v1|${groupId}`);
}

export async function sealDocBody(signed, pin, groupId) {
  if (!signed || !signed.id || !signed.sig || !signed.body) return null;
  const key = await importAesKey(await docContentKey(pin, groupId), ['encrypt']);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify({ id: signed.id, sig: signed.sig, body: signed.body }));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: senderAad(groupId) },
    key,
    plaintext,
  );
  // Reuse groupCipher's envelope shape (v/iv/ct b64) without dragging its
  // epoch/sender AAD semantics here — those bind to chat key epochs.
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
  return JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
}

async function importAesDecryptKey(raw) {
  return importAesKey(raw, ['decrypt']);
}

export async function openSealedDocBody(contentJson, pin, groupId) {
  let envelope;
  try {
    envelope = typeof contentJson === 'string' ? JSON.parse(contentJson) : contentJson;
  } catch {
    return null;
  }
  if (!envelope || envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') return null;
  try {
    const key = await importAesDecryptKey(await docContentKey(pin, groupId));
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: senderAad(groupId) },
      key,
      unb64(envelope.ct),
    );
    const parsed = JSON.parse(new TextDecoder().decode(pt));
    return parsed && parsed.id && parsed.sig && parsed.body ? parsed : null;
  } catch {
    return null;
  }
}

// Build the wire event. `createdAt` arrives stamped by the caller (H2:
// max(prev.created_at + 1, now)); passing it in keeps the stamp rule testable
// against fixed clocks instead of buried next to Date.now().
export async function buildMemberDocEvent({ signedDoc, authoritySk, pin, groupId, createdAt }) {
  if (!authoritySk || !(authoritySk instanceof Uint8Array) || authoritySk.length !== 32) return null;
  const canonical = canonicalBody(signedDoc?.body || signedDoc);
  if (!canonical || !Number.isInteger(Number(createdAt))) return null;
  const ciphertext = await sealDocBody(signedDoc, pin, groupId);
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
  const opened = await verifyAgainstPin({ groupId, pin, signed });
  if (!opened) return null;
  // `opened` is the verified body carrying its recomputed id; pass it under
  // the wrapper shape storeVerifiedDocRow expects.
  return storeVerifiedDocRow({ groupId, signed: { id: opened.id, sig: signed?.sig || '', body: opened } });
}

export async function verifyAgainstPin({ groupId, pin, signed }) {
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
