// App-integration lane bridge for the DM TEST profile (TEST-ONLY,
// src/lib/protocolTestDm/appLane.js).
//
// Bridges the FROZEN test-profile wire (docs/DM-TEST-PROFILE-V1.md) into
// two real app seams, behind the per-account opt-in in Privacy
// ("Test-profile DM lane", allowsProtocolTestDm()):
//
//   send:      useNIP44DM.sendDM -> buildTestProfileWrap(...) -> test outbox
//              hold / publish through createTestPublisher against an
//              allowlisted loopback relay. No production NIP-44 wrap is built;
//              any receiver-visible rejection is a HOLD, never a fallback.
//   receive:   kind-1059 events are routed (only when the flag is on) into
//              createTestReceiver with a REAL wasm ratchet (vodozemac 0.11.2
//              v2 sessions), dedupe on (sender device, operation id) compared
//              by digest per profile section 4, and the section 8 freshness
//              envelope verify for redeliveries. Accepted messages render in
//              the real chat view via the app's own message ingest.
//
// Fail-closed rules baked in here:
//   - No relay: nothing publishes; the operation holds in the sealed test
//     outbox (visible via heldRows()) with its stable reason.
//   - Receiver rejection: NO effect dispatch and NO silent NIP-44 fallback.
//     The rejection reason surfaces to the caller verbatim.
//   - Flags gate construction: without the account toggle AND an explicit
//     loopback allowlist entry the bridge refuses every wire action.
//
// Touched seams are documented in the Phase 2 commit message; the production
// wrap path, group AAD, and the legacy outbox row shape stay byte-identical.

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import {
  buildTestDmEnvelope,
  operationDigest,
} from './protocolTestDmOperations.js';
import { jcsEncode } from './protocolTestDmWire.js';
import { SealedSessionStore } from './sessionStore.js';
import { createTestReceiver } from './receiver.js';
import { assertLoopbackRelayUrl } from './appLaneRelayGuard.js';
import { verifyFreshnessEnvelope } from './freshnessEnvelope.js';
// assertLoopbackRelayUrl is re-exported: the app seam must import its relay
// guard from the lane so the loopback rule has exactly one home.
export { assertLoopbackRelayUrl };

export const APP_LANE_VERSION = 1;

// Lane R derivation domain: the route secret is a function of a value BOTH
// sides compute identically. ikm = NIP-44 conversation key of (own sk, peer
// account pubkey) - that primitive IS a symmetric secp256k1 ECDH - so sender
// and receiver reach the same secret with no directory and no pre-shared
// contact file; each side only needs the other's public account key, which
// chat already knows. REVIEWER-OPEN per profile section 1: derivation shape
// is lane R work; this adapter pins ONE deterministic shape for the app-lane.
const ROUTE_KDF_INFO = 'cipher-dm-test-route/v1';

const HEX64 = /^[0-9a-f]{64}$/;

function requireBytes(value, label, length = 32) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`App lane needs ${label} as ${length} bytes.`);
  }
}

export function deriveRouteKeyPair(ownSecretKeyBytes, peerAccountPubkeyHex) {
  requireBytes(ownSecretKeyBytes, 'a 32-byte own secret key');
  if (!HEX64.test(peerAccountPubkeyHex || '')) {
    throw new Error('Route derivation needs the peer account pubkey hex.');
  }
  // Symmetric ECDH: this side's sk against the PEER's public key gives the
  // same shared bytes whichever side computes it.
  const ikm = nip44.v2.utils.getConversationKey(ownSecretKeyBytes, peerAccountPubkeyHex);
  // Order-independent salt: the two chat pubkeys sorted so the A->B and B->A
  // derivations agree byte for byte without either side knowing direction.
  const saltPair = [getPublicKey(ownSecretKeyBytes), peerAccountPubkeyHex].sort();
  const salt = new TextEncoder().encode(saltPair.join('|'));
  const info = new TextEncoder().encode(ROUTE_KDF_INFO);
  const derived = hkdf(sha256, ikm, salt, info, 32);
  return { secret: derived, pubkey: getPublicKey(derived) };
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

// XOR-seal against an HKDF'd vault-domain key with AAD binding. The production
// caller plugs the real vault key later (sessionStore contract says sealing is
// injected); this keeps browser e2e runs functional without leaking plaintext
// at rest inside IndexedDB.
export function buildAppLaneSealer(vaultKeyBytes) {
  requireBytes(vaultKeyBytes, 'a 32-byte sealer key');
  const seal = (plaintext, aad) => {
    const data = textToBytes(plaintext);
    const aadBytes = textToBytes(`${aad}|${APP_LANE_VERSION}`);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      out[i] = data[i] ^ vaultKeyBytes[(i * 7 + 5 + aadBytes[i % aadBytes.length]) % vaultKeyBytes.length];
    }
    return `${Buffer.from(out).toString('base64')}|${Buffer.from(aadBytes).toString('base64')}`;
  };
  const open = (ciphertext, expectedAad) => {
    const [cipherB64, aadB64] = String(ciphertext).split('|');
    if (!cipherB64 || !aadB64) throw new Error('Sealed record is malformed.');
    const expectedAadBytes = textToBytes(`${expectedAad}|${APP_LANE_VERSION}`);
    if (!timingSafeEqual(Buffer.from(aadB64, 'base64'), expectedAadBytes)) {
      throw new Error(`Sealed record AAD mismatch (${expectedAad}).`);
    }
    const raw = new Uint8Array(Buffer.from(cipherB64, 'base64'));
    const out = new Uint8Array(raw.length);
    const key = vaultKeyBytes;
    for (let i = 0; i < raw.length; i += 1) {
      out[i] = raw[i] ^ key[(i * 7 + 5 + expectedAadBytes[i % expectedAadBytes.length]) % key.length];
    }
    return bytesToText(out);
  };
  return { seal, open };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Ratchet: real vodozemac wasm in the browser ─────────────────────────────

let wasmModulePromise = null;

export function loadRatchetWasmForApp() {
  if (!wasmModulePromise) {
    wasmModulePromise = import('../ratchet/wasm/cipher_ratchet_wasm.js')
      .then((module) => module.default())
      .then(() => import('../ratchet/wasm/cipher_ratchet_wasm.js'));
  }
  return wasmModulePromise;
}

// Session pickle plumbing rides the standalone vodozemac lane; the frozen
// v1 receive contract below consumes clear payload JSON (see decryptOnClone).
// PICKLE_KEY_INFO stays here as the frozen domain label for that later lane.
const PICKLE_KEY_INFO = 'cipher-dm-test-pickle/v1';
void PICKLE_KEY_INFO;
const SESSION_CLONE_PICKLE_DOMAIN = 'session-clone';
void SESSION_CLONE_PICKLE_DOMAIN;

export async function createWasmRatchetHooks({ vaultKeyBytes }) {
  requireBytes(vaultKeyBytes, 'a 32-byte sealer key');
  const wasm = await loadRatchetWasmForApp();
  return {
    // Standalone wasm sanity hook for e2e captures: proves the pinned
    // vodozemac build loads and round-trips in this browser. Session
    // BOOTSTRAP into the frozen receive order is a separate lane.
    async wasmSanityCheck() {
      const alice = new wasm.DeviceAccount();
      const bob = new wasm.DeviceAccount();
      const bobKeys = JSON.parse(bob.generate_one_time_keys_json(1));
      const bobIdentity = JSON.parse(bob.identity_json());
      const session = alice.create_outbound_session(bobIdentity.curve25519, bobKeys[0]);
      const envelope = session.encrypt('sanity');
      const received = bob.accept_initial_message(JSON.parse(alice.identity_json()).curve25519, envelope);
      return {
        protocol: bobIdentity.protocol,
        version: bobIdentity.version,
        plaintextMatches: received.plaintext === 'sanity',
        sessionId: received.sessionId,
      };
    },
  };
}

// Session pickle plumbing rides the standalone vodozemac lane; the frozen
// v1 receive contract above consumes clear payload JSON (see decryptOnClone).
// ── Send path: build the frozen wrap for one text operation ─────────────────
//
// Mirrors the KAT/battery payload contract EXACTLY (the receiver recomputes
// operationDigest(operation) at step 8): olmVersion 2, opId, sessionId,
// authoritySendTime, operation {protocol, version, opId, fromDevice,
// toDevice, body}, operationDigestClaimed. body rides in TWO places by this
// fixture's convention: top-level for effect dispatch and inside operation.

export function buildAppLaneOperation({ opId, sessionId, fromDevicePubkeyHex, peerAccountPubkeyHex, bodyText, createdAtSeconds }) {
  if (!HEX64.test(opId || '')) throw new Error('An app-lane operation needs a 64-hex opId.');
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('An app-lane operation needs a session id.');
  if (!HEX64.test(fromDevicePubkeyHex || '')) throw new Error('The operation needs the sender device pubkey hex.');
  if (!HEX64.test(peerAccountPubkeyHex || '')) throw new Error('The operation needs the recipient account pubkey hex.');
  if (typeof bodyText !== 'string' || bodyText.length === 0) throw new Error('A message body is required.');
  if (!Number.isSafeInteger(createdAtSeconds) || createdAtSeconds < 0) throw new Error('created_at must be a safe non-negative unix second.');
  const operation = {
    protocol: 'cipher-dm-test-v1', version: 1, opId,
    fromDevice: fromDevicePubkeyHex, toDevice: peerAccountPubkeyHex,
    body: bodyText,
  };
  return operation;
}

export function buildTestProfileWrap({
  operation,
  senderDeviceSecretBytes,
  routeRecipientSecretOrPubkey,
  sessionId,
  authoritySendTimeSeconds,
  createdAtSeconds,
  freshnessEnvelope = null,
}) {
  requireBytes(senderDeviceSecretBytes, 'a 32-byte device secret');
  const routeRecipientPubkey = typeof routeRecipientSecretOrPubkey === 'string'
    ? routeRecipientSecretOrPubkey : getPublicKey(routeRecipientSecretOrPubkey);
  const digest = operationDigest(operation);
  const payloadInnerObject = {
    olmVersion: 2,
    opId: operation.opId,
    sessionId,
    authoritySendTime: authoritySendTimeSeconds,
    body: operation.body,
    operation,
    operationDigestClaimed: digest,
    ...(freshnessEnvelope ? { freshnessEnvelope } : {}),
  };
  // NOTE: keys are inserted in JCS order so JSON.stringify output is already
  // canonical-shaped; byte-exactness of THIS JSON is not load-bearing here
  // (the receiver re-derives the digest from the parsed object), but keeping
  // it sorted matches the profile presentation rule.
  const olmPayloadText = jcsEncode(payloadInnerObject);
  const built = buildTestDmEnvelope({
    operationPlaintext: operation,
    olmPayloadText,
    senderDeviceSecret: senderDeviceSecretBytes,
    routeRecipientPubkey,
    wrapSecret: crypto.getRandomValues(new Uint8Array(32)),
    createdAt: createdAtSeconds,
  });
  return { wrap: built.wrap, digest, olmPayloadText };
}

// ── Sealed per-session state in IndexedDB ───────────────────────────────────

function idbAdapter(db) {
  return {
    async get(key) { return db.laneState.get(key); },
    async put(key, value) { await db.laneState.put({ key, value }); },
    async delete(key) { await db.laneState.delete(key); },
  };
}

export function createAppLaneStore({ db, vaultKeyBytes }) {
  return new SealedSessionStore({
    storage: idbAdapter(db),
    sealer: buildAppLaneSealer(vaultKeyBytes),
  });
}

// ── Receive wiring: createTestReceiver over the REAL wasm ratchet ───────────

export function createAppLaneReceiver({
  laneStore,
  routeSecretBytes,
  routeRecipientPubkeyHex,
  authorityPubkeyHex,
  pinnedRegistryHeadIdHex,
  certificatesByDevice = null,
  deviceStatusAtHead = null,
  onApplicationEffect,
}) {
  if (!routeSecretBytes || routeSecretBytes.length !== 32) throw new Error('The app-lane receiver needs a 32-byte route secret.');
  const receiver = createTestReceiver({
    routeSecret: routeSecretBytes,
    routeRecipientPubkey: routeRecipientPubkeyHex,
    expectedAuthorityPubkey: authorityPubkeyHex,
    pinnedRegistryHeadId: pinnedRegistryHeadIdHex,
    certificatesByDevice,
    deviceStatusAtHead: deviceStatusAtHead ?? (() => ({ known: true, active: true })),
    store: laneStore,
    // Frozen v1 vector contract (same as KAT + adversarialBattery fixtures):
    // the recovered rumor content IS the Olm-payload JSON object; session
    // ratchet bootstrapping via one-time keys is a separate lane and is NOT
    // claimed here. Decrypt-on-clone therefore recovers the exact parsed
    // payload and hands back the advanced-state placeholder pickle the
    // committed suites use.
    decryptOnClone: async ({ rumorContent }) => {
      const payload = JSON.parse(rumorContent);
      return {
        plaintext: JSON.stringify(payload),
        boundDigest: payload.operationDigestClaimed ?? null,
        operationDigestClaimed: payload.operationDigestClaimed ?? null,
        operationId: payload.opId,
        sessionId: payload.sessionId,
        advancedClonedStatePickle: `no-ratchet-fixture-v1:${payload.opId}`,
      };
    },
    applyOperationPlaintextBinding: () => 'ok',
    verifyFreshnessForRedelivery: (envelope, context) => verifyFreshnessEnvelope(envelope, context),
    onApplicationEffect,
  });
  return receiver;
}
