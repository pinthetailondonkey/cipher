// Governance binding for the MLS v1 test profile
// (docs/MLS-TEST-PROFILE-V1.md Section 1, plan item 13).
//
// TEST PROFILE ONLY. This is the pure core: canonical serialization,
// extension build, committer role authorization at a pinned previous
// revision, and the cross-hash direction (extension cites the previous
// revision; the NEXT governance document cites the commit hash and the
// resulting transcript hash). No relay, no DB, no real MLS library here.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Canonical JSON: sorted keys, stable output, so two devices that hold
// semantically equal objects hash identically.
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

export async function canonicalHash(value) {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalStringify(value))));
}

// Build the authenticated GroupContext extension payload. The committer
// passes its own computed commit hash binding and the pinned previous
// revision. `actorPins` are compressed secp256k1 pins bound out of band.
export async function buildGovernanceExtension({
  groupId, prevRev, prevHash, actorPins, commitHashBinding,
}) {
  const rev = Number(prevRev);
  if (!Number.isInteger(rev) || rev < 0) return null;
  if (!/^[0-9a-f]{64}$/.test(String(prevHash || ''))) return null;
  if (!/^[0-9a-f]{64}$/.test(String(commitHashBinding || ''))) return null;
  const pins = [...new Set((Array.isArray(actorPins) ? actorPins : [])
    .map((p) => String(p || '').toLowerCase())
    .filter((p) => /^[0-9a-f]{66}$/.test(p)))]
    .sort();
  if (pins.length === 0) return null;
  const body = {
    commitHashBinding,
    prevHash: String(prevHash).toLowerCase(),
    prevRev: rev,
    actorPins: pins,
    t: 'mlsgovbind',
  };
  if (groupId) body.groupId = String(groupId);
  return {
    body,
    bindingHash: await canonicalHash({ ...body, groupId: body.groupId || '' }),
  };
}

// The role at a revision: only `owner` or `admin` may commit. The document
// shape follows the groupDoc convention ({ pubkey, role, gen }).
function roleOf(doc, actorKey) {
  const rows = Array.isArray(doc?.body?.members) ? doc.body.members : [];
  const row = rows.find((r) => r && (r.pubkey === actorKey || r.actor === actorKey));
  return row ? row.role : null;
}

export function isAuthorizedRole(role) {
  return role === 'admin' || role === 'owner';
}

// Verify a commit's governance extension against the governance document at
// the revision the extension itself names. Returns the accepted reasons or
// null. This is the receiver-side check a relay cannot forge.
export async function verifyCommitGovernance({
  extension, commitHashBinding, governanceDoc, signerActor,
}) {
  if (!extension || typeof extension !== 'object' || !extension.body) return null;
  const rebuilt = await buildGovernanceExtension({
    groupId: extension.body.groupId,
    prevRev: extension.body.prevRev,
    prevHash: extension.body.prevHash,
    actorPins: extension.body.actorPins,
    commitHashBinding: extension.body.commitHashBinding,
  });
  if (!rebuilt || rebuilt.bindingHash !== extension.bindingHash) return null;
  if (extension.body.commitHashBinding !== commitHashBinding) return null;
  if (!isAuthorizedRole(roleOf(governanceDoc, signerActor))) return null;
  const docRev = Number(governanceDoc?.body?.gen);
  if (docRev !== extension.body.prevRev) return null;
  const docHash = await canonicalHash(governanceDoc?.body ?? null);
  if (docHash !== extension.body.prevHash) return null;
  return { bindingHash: rebuilt.bindingHash, prevRev: extension.body.prevRev };
}

// Derive the NEXT governance document references: the next document cites
// the commit hash and the transcript hash AFTER the commit. The previous
// revision stays pinned in the extension, avoiding a circular hash.
export async function deriveNextGovernanceRefs({
  prevRev, commitBytes, transcriptHash, membershipDelta,
}) {
  return {
    prevRev,
    commitHash: await canonicalHash({ commitBytes: bytesToHex(commitBytes) }),
    transcriptHash,
    membershipDelta: membershipDelta ?? null,
  };
}

// Check that a next-revision governance document's citations match the
// derived refs for the commit it claims to attest.
export async function verifyNextGovernanceCitation({
  governanceDoc, refs,
}) {
  const cited = governanceDoc?.body?.mlsRefs;
  if (!cited) return false;
  return canonicalStringify(cited) === canonicalStringify({
    prevRev: refs.prevRev,
    commitHash: refs.commitHash,
    transcriptHash: refs.transcriptHash,
    membershipDelta: refs.membershipDelta,
  });
}
