// Canonical MLS-over-Nostr relay envelope for the MLS v1 TEST PROFILE ONLY
// (docs/MLS-TEST-PROFILE-V1.md Section 3 + open items). This wraps opaque MLS
// wire bytes and per-member epoch attestations in a signed Nostr event so the
// disposable loopback relay stores/delivers only ciphertext-like material,
// exactly as the DM design already does with kind 1059 gift wraps.
//
// NO PRODUCTION PATH USES THIS FILE. All verification here is fail-closed:
// any malformed input yields a stable machine-readable reason, never a
// best-effort accept.

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { verifyEpochAttestation } from './epochAttestation.js';

export const RELAY_ENVELOPE_KIND = 10606;

// REVIEWER-OPEN: kind 10606 sits in the 1000-19999 "not standardized" band
// chosen to avoid every kind currently used in this repo (4, 13, 14, 1059,
// 22242). Whether this becomes a NIP-proposal number is a profile-freeze
// decision recorded in docs/MLS-TEST-PROFILE-V1.md Section 9.

export const WIRE_FORMATS = ['mLSMessage', 'welcome', 'commit'];

const ENVELOPE_T = 'cipherMlsRelayEnvelope';
const ENVELOPE_V = 1;

export const VERIFY_REASONS = {
  NOT_AN_EVENT: 'envelope-not-an-event',
  SIGNATURE: 'envelope-signature',
  KIND: 'envelope-kind',
  CONTENT: 'envelope-content',
  SCHEMA: 'envelope-schema',
  WIRE_FORMAT: 'envelope-wire-format',
  GOVERNANCE: 'governance-mismatch',
  ATTESTATION: 'attestation-invalid',
  EPOCH_REGRESSION: 'epoch-regression',
};

const fail = (reason, detail) => ({ ok: false, reason, detail });

function isHex64(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// Deterministic signer (same convention as scripts/gen-dm-kat.mjs signDet):
// fixed 32-byte auxiliary randomness so identical templates produce identical
// signatures. Never production signing.
export function signEventDeterministically(template, secretKeyBytes) {
  const t = { ...template };
  t.pubkey = getPublicKey(secretKeyBytes);
  const id = getEventHash(t);
  t.id = id;
  const message = hexToBytes(id);
  t.sig = bytesToHex(schnorr.sign(message, secretKeyBytes, new Uint8Array(32)));
  return t;
}

// Build + sign one relay envelope event. Returns null on any invalid input
// (fail-closed construction, not throwing).
export async function buildRelayEnvelope({
  groupId, epoch, wireFormat, mlsBytes, governanceRevision, governanceHash,
  senderDeviceId, authoritySecret, attestations = [], created_at,
  recipientDeviceId = null,
}) {
  try {
    if (typeof groupId !== 'string' || !groupId) return null;
    const epochNum = Number(epoch);
    if (!Number.isInteger(epochNum) || epochNum < 0) return null;
    const rev = Number(governanceRevision);
    if (!Number.isInteger(rev) || rev < 0) return null;
    if (!isHex64(governanceHash)) return null;
    if (!WIRE_FORMATS.includes(wireFormat)) return null;
    let mlsHex = '';
    if (typeof mlsBytes === 'string') mlsHex = mlsBytes.toLowerCase();
    else if (mlsBytes instanceof Uint8Array || Buffer.isBuffer(mlsBytes)) mlsHex = bytesToHex(new Uint8Array(mlsBytes));
    if (!/^[0-9a-f]*$/.test(mlsHex)) return null;
    if (!isHex64(authoritySecret)) return null;
    const attestList = Array.isArray(attestations) ? attestations : [];
    const content = {
      t: ENVELOPE_T,
      v: ENVELOPE_V,
      mlsGroupId: String(groupId || ''),
      epoch: epochNum,
      wireFormat,
      mlsBytesHex: mlsHex,
      governanceRef: { revision: rev, hash: String(governanceHash).toLowerCase() },
      attestations: attestList,
    };
    const tags = [
      ['d', content.mlsGroupId],
      ['epoch', String(epochNum)],
      ['wireformat', wireFormat],
      ['govrev', String(rev)],
      ['sender-device', String(senderDeviceId || '')],
    ];
    if (recipientDeviceId) tags.push(['p', String(recipientDeviceId)]);
    const template = {
      kind: RELAY_ENVELOPE_KIND,
      created_at: Number.isInteger(created_at) ? created_at : Math.floor(Date.now() / 1000),
      tags,
      content: canonicalJson(content),
    };
    return signEventDeterministically(template, hexToBytes(authoritySecret));
  } catch {
    return null;
  }
}

// Parse + fully verify one envelope. Fail-closed with stable reasons.
export async function parseAndVerifyRelayEnvelope(event, options = {}) {
  try {
    if (!event || typeof event !== 'object') return fail(VERIFY_REASONS.NOT_AN_EVENT, 'missing event');
    if (!verifyEvent(event)) return fail(VERIFY_REASONS.SIGNATURE, 'nostr event signature invalid');
    if (event.kind !== RELAY_ENVELOPE_KIND) return fail(VERIFY_REASONS.KIND, `kind ${event?.kind}`);
    if (typeof event.content !== 'string') return fail(VERIFY_REASONS.CONTENT, 'content not string');
    let parsed;
    try { parsed = JSON.parse(event.content); } catch { return fail(VERIFY_REASONS.CONTENT, 'content not JSON'); }
    if (!parsed || typeof parsed !== 'object') return fail(VERIFY_REASONS.CONTENT, 'content empty');
    if (parsed.t !== ENVELOPE_T || parsed.v !== ENVELOPE_V) return fail(VERIFY_REASONS.SCHEMA, 'unknown envelope type/version');
    if (typeof parsed.mlsGroupId !== 'string' || !parsed.mlsGroupId) return fail(VERIFY_REASONS.SCHEMA, 'missing mlsGroupId');
    if (!Number.isInteger(parsed.epoch) || parsed.epoch < 0) return fail(VERIFY_REASONS.SCHEMA, 'bad epoch');
    if (!WIRE_FORMATS.includes(parsed.wireFormat)) return fail(VERIFY_REASONS.WIRE_FORMAT, `wireFormat ${parsed.wireFormat}`);
    if (!/^[0-9a-f]*$/.test(String(parsed.mlsBytesHex || ''))) return fail(VERIFY_REASONS.CONTENT, 'bad mlsBytesHex');
    const gref = parsed.governanceRef;
    if (!gref || !Number.isInteger(gref.revision) || gref.revision < 0 || !isHex64(gref.hash)) {
      return fail(VERIFY_REASONS.GOVERNANCE, 'malformed governanceRef');
    }
    // Governance chain check: the cited (revision, hash) pair must exist in
    // the receiver's expected chain, when one was supplied.
    if (options.expectedGroupRevisionChain) {
      const chain = options.expectedGroupRevisionChain;
      const revisions = Array.isArray(chain)
        ? Object.fromEntries(chain.map((entry) => [entry.revision, entry.hash]))
        : (chain.revisions || {});
      const expectedHash = revisions[gref.revision];
      if (!expectedHash) return fail(VERIFY_REASONS.GOVERNANCE, `unknown revision ${gref.revision}`);
      if (String(expectedHash).toLowerCase() !== gref.hash) return fail(VERIFY_REASONS.GOVERNANCE, 'governance hash mismatch at cited revision');
    }
    // Authority binding: the envelope MUST be signed by the expected group
    // authority device key. Signed-but-unauthorized is a governance failure.
    if (options.expectedGovernanceAuthorityPubkey) {
      if (event.pubkey !== String(options.expectedGovernanceAuthorityPubkey)) {
        return fail(VERIFY_REASONS.GOVERNANCE, 'signed by unexpected authority');
      }
    }
    // Epoch regression against the receiver's local view.
    if (options.currentEpoch !== undefined && Number.isFinite(options.currentEpoch)) {
      if (parsed.epoch < Number(options.currentEpoch)) {
        return fail(VERIFY_REASONS.EPOCH_REGRESSION, `epoch ${parsed.epoch} below receiver ${options.currentEpoch}`);
      }
    }
    // Attestations: optional on transport-level frames such as welcome, but
    // every attestation present must verify cryptographically AND bind the
    // same groupId+epoch carried in the envelope.
    if (!Array.isArray(parsed.attestations)) return fail(VERIFY_REASONS.SCHEMA, 'attestations missing');
    for (const attestation of parsed.attestations) {
      const verified = await verifyEpochAttestation(attestation);
      if (!verified) return fail(VERIFY_REASONS.ATTESTATION, 'signature/binding failed');
      if (verified.groupId !== parsed.mlsGroupId) return fail(VERIFY_REASONS.ATTESTATION, 'attestation binds another group');
      if (verified.epoch !== parsed.epoch) return fail(VERIFY_REASONS.ATTESTATION, 'attestation binds another epoch');
    }
    return {
      ok: true, reason: null,
      envelope: {
        type: parsed.t, version: parsed.v, mlsGroupId: parsed.mlsGroupId, epoch: parsed.epoch,
        wireFormat: parsed.wireFormat, mlsBytesHex: parsed.mlsBytesHex,
        governanceRef: { revision: gref.revision, hash: gref.hash },
        attestations: parsed.attestations,
      },
      eventId: event.id, senderPubkey: event.pubkey, senderDeviceTag: event.tags?.find((t) => t[0] === 'sender-device')?.[1] ?? null,
    };
  } catch (error) {
    return fail('envelope-internal-error', error?.message || String(error));
  }
}
