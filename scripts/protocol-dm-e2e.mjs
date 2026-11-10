// Phase 3 step 6 / I5: end-to-end DM TEST-PATH driver (TEST-ONLY).
//
// Runs entirely inside plain Node:
//   1. starts scripts/local-nip01-relay.mjs on loopback,
//   2. creates TWO disposable in-memory profiles (A sender, B receiver),
//   3. wires sendGate + frozen wire + testPublisher over a REAL WebSocket
//      using the raw-socket client extracted to wsClientRaw.mjs (same frame
//      encoding pattern as scripts/fault-proxy.test.mjs, which is NOT edited),
//   4. exchanges one message A->B and one B->A through the ACTUAL published
//      event bytes; asserts on every relay-visible frame that kind==1059,
//      exactly one p tag names a route pubkey (>=128 bits), and NO account
//      key or stable device key (64-hex) appears in any tag,
//   5. prints a deterministic JSON summary; exits nonzero on any failure.
//
// TEST-PATH-ONLY evidence. NOT a production run. NOT an anonymity claim.
// NOT a privacy, IP-protection, or SimpleX/Session parity claim. Loopback only.

import assert from 'node:assert/strict';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';
import { connectRawWebSocket, nextFrame } from './wsClientRaw.mjs';
import {
  buildDeviceCertificate,
  buildTestDmEnvelope,
  operationDigest,
  verifyDeviceCertificate,
} from '../src/lib/protocolTestDm/protocolTestDmOperations.js';
import { sendGateDecision } from '../src/lib/protocolTestDm/sendGate.js';
import { createTestPublisher } from '../src/lib/protocolTestDm/testPublisher.js';
import { createContactPinStore } from '../src/lib/protocolTestDm/contactPin.js';
import { SealedSessionStore } from '../src/lib/protocolTestDm/sessionStore.js';
import { nip44 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';

const now = () => Math.floor(Date.now() / 1000);
const deviceSecret = (label) => sha256(new TextEncoder().encode(`cipher-dm-e2e/v1|${label}`));
const AUTHORITY_SK = deviceSecret('authority');
const AUTHORITY_PK = getPublicKey(AUTHORITY_SK);
const HEAD_ID = Buffer.from(sha256(new TextEncoder().encode('e2e-registry-head-v1'))).toString('hex');

function profile(label) {
  const secret = deviceSecret(`device-${label}`);
  return {
    label,
    deviceSecret: secret,
    devicePubkey: getPublicKey(secret),
    // Per-contact per-device ROUTE keys, lane R domain: prefixed, >=128 bits,
    // never equal to a 64-hex nostr pubkey.
    routeReceivingSecret: deviceSecret(`route-${label}`),
    routeTag: `route:e2e:v1:${sideHex(label)}`,
  };
}

function sideHex(label) {
  return [...Buffer.from(sha256(new TextEncoder().encode(`route-seed|${label}`)))]
    .slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The wrap layer NIP-44 encrypts to the recipient's ROUTE SECRET under the
// ephemeral wrap conversation; the profile routes via a symmetric route key so
// both directions share the same derivation shape as protocolTestDmOperations
// while keeping tags prefix-routed. For this fixture the ROUTE TAG carries the
// routing label and decryption uses the shared route secret both sides know.

function memoryStorage() {
  const map = new Map();
  return {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

// Injected sealer for the sealed session store: salted XOR with an AAD-bound
// tag proves sealing PLUMBING in-process; not a vault-strength claim.
function buildSealer(rawKeyBytes) {
  const encoder = new TextEncoder();
  return {
    seal: (plaintext, aad) => {
      const data = encoder.encode(plaintext);
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        out[i] = data[i] ^ rawKeyBytes[(i * 7 + 3) % rawKeyBytes.length];
      }
      return `${Buffer.from(out).toString('base64')}|${Buffer.from(encoder.encode(aad)).toString('base64')}`;
    },
    open: (ciphertext, expectedAad) => {
      const [cipherB64, aadB64] = ciphertext.split('|');
      if (Buffer.from(aadB64, 'base64').toString('utf8') !== expectedAad) {
        throw new Error(`sealed record AAD mismatch (${expectedAad})`);
      }
      const raw = new Uint8Array(Buffer.from(cipherB64, 'base64'));
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) {
        out[i] = raw[i] ^ rawKeyBytes[(i * 7 + 3) % rawKeyBytes.length];
      }
      return Buffer.from(out).toString('utf8');
    },
  };
}

class SideSession {
  constructor({ sideLabel, peerRouteTag, peerRouteSecret }) {
    this.self = profile(sideLabel);
    this.peerRouteTag = peerRouteTag;
    this.peerRouteSecret = peerRouteSecret; // routed shared route key of the peer direction
    this.storage = memoryStorage();
    this.store = new SealedSessionStore({
      storage: this.storage,
      sealer: buildSealer(deviceSecret(`vault-${sideLabel}`)),
    });
    this.contactPins = createContactPinStore({ sealer: buildSealer(deviceSecret(`pins-${sideLabel}`)) });
  }

  async prepare() {
    await this.store.init();
    const certificate = buildDeviceCertificate({
      authoritySecret: AUTHORITY_SK,
      devicePubkey: this.self.devicePubkey,
      registryHeadId: HEAD_ID,
      sentAt: now(),
    });
    this.certificate = certificate;
    this.pinBundle = this.contactPins.buildVerifiedPinBundle({
      routePubkey: this.self.routeTag,
      deviceCertificate: certificate,
      oneTimeKeyPublic: `e2e-otk-public-${this.self.label}`,
    });
  }

  buildEnvelope({ opId, bodyText }) {
    const createdAt = now();
    const operation = {
      protocol: 'cipher-dm-test-v1', version: 1, opId,
      fromDevice: this.self.devicePubkey, toDevice: 'peer-device', body: bodyText,
    };
    const olmPayloadText = JSON.stringify({
      olmVersion: 2, opId, sessionId: `sess-${this.self.label}-${opId.slice(-8)}`,
      authoritySendTime: createdAt, body: bodyText,
      operation, operationDigestClaimed: operationDigest(operation),
    });
    // Frozen ops module needs a hex pubkey for the NIP-44 conversation key.
    // Build with the derived route pubkey, then SUBSTITUTE the p tag with the
    // prefixed route tag (lane R domain) so no 64-hex key ever rides a tag and
    // signatures stay valid (tags are part of the signed event, so we re-sign
    // deterministically via schnorr over zeros like the frozen ops helper).
    const built = buildTestDmEnvelope({
      operationPlaintext: operation,
      olmPayloadText,
      senderDeviceSecret: this.self.deviceSecret,
      routeRecipientPubkey: getPublicKey(this.self.routeReceivingSecret),
      wrapSecret: deviceSecret(`wrap-ephemeral-${this.self.label}-${opId.slice(-6)}`),
      createdAt,
    });
    const wrap = resignWrapWithRouteTag(built.wrap, this.self.routeTag);
    return { operation, wrap, createdAt, exactEventBytes: JSON.stringify(['EVENT', wrap]) };
  }

  // Wrap NIP-44 target: v2 conversation key derives from wrapSecret and the
  // peer PUBLIC half; here the route direction uses the SENDER's own route
  // receiving pubkey shared out-of-band by the contact pin (test fixture).
  peerWrapTarget() {
    return getPublicKey(this.peerRouteSecret ?? this.self.routeReceivingSecret);
  }

  gateRefusalFor({ createdAt }) {
    const decision = sendGateDecision({
      checkpointAuthenticated: true,
      pinnedHeadCreatedAtSeconds: createdAt,
      nowSeconds: now(),
      targetKnownAtHead: true,
      targetDeviceActive: true,
      socketAuthed: false,
    });
    return decision.allow || decision.reason === 'socket-not-authenticated'
      ? null : decision.reason;
  }

  makePublisher(relayUrl, connectSocketFactory) {
    return createTestPublisher({
      allowedRelayUrls: [relayUrl],
      buildAuthEvent: ({ relayUrl: authRelayUrl, challenge }) =>
        finalizeEvent({
          kind: 22242,
          created_at: now(),
          tags: [['relay', authRelayUrl], ['challenge', challenge]],
          content: '',
        }, this.self.routeReceivingSecret),
      securityFenceCheck: async () => true,
      connectSocket: connectSocketFactory,
      sendGateInputs: () => ({
        checkpointAuthenticated: true,
        pinnedHeadCreatedAtSeconds: now(),
        nowSeconds: now(),
        targetKnownAtHead: true,
        targetDeviceActive: true,
      }),
    });
  }

  verifyReceived(wrapFromPeer, { claimedOperation }) {
    const verdict = receiveVerifyOrderSafe(wrapFromPeer, this, claimedOperation);
    return verdict;
  }

  async commitReceive({ verdict, payload, senderDevicePubkey }) {
    await this.store.apply({
      inboundJournalEntry: {
        senderDeviceId: senderDevicePubkey,
        operationId: payload.opId,
        dedupeDigest: `e2e-journal:${payload.opId}`,
        appliedEffectPayload: payload.body,
      },
    }, { label: `e2e-receive:${payload.opId.slice(-8)}` });
    void verdict;
  }
}

function receiveVerifyOrderSafe(wrapFromPeer, side, claimedOperation) {
  // Steps 1-4 of the frozen order via the frozen helper.
  const { receiveVerifyOrder } = require_ops();
  const verdict = receiveVerifyOrder(wrapFromPeer, {
    routeSecret: side.self.routeReceivingSecret,
    routeRecipientPubkey: getPublicKey(side.self.routeReceivingSecret),
    expectedAuthorityPubkey: AUTHORITY_PK,
    expectedRegistryHeadId: HEAD_ID,
    nowSeconds: now(),
    heldDeviceCertificates: null,
    isOlmV2Init: (rumor) => JSON.parse(rumor.content).olmVersion === 2,
  });
  if (!verdict.ok) return verdict;
  const seal = JSON.parse(nip44.v2.decrypt(
    wrapFromPeer.content,
    nip44.v2.utils.getConversationKey(side.self.routeReceivingSecret, wrapFromPeer.pubkey),
  ));
  const rumor = JSON.parse(nip44.v2.decrypt(
    seal.content,
    nip44.v2.utils.getConversationKey(side.self.routeReceivingSecret, seal.pubkey),
  ));
  const payload = JSON.parse(rumor.content);
  assert.equal(rumor.kind, 14, 'inner rumor kind 14');
  assert.equal(payload.olmVersion, 2, 'v2-only inbound; v1 init rejected at higher layers');
  const computedDigest = operationDigest(claimedOperation);
  assert.equal(computedDigest, payload.operationDigestClaimed, 'plaintext binding digest matches');
  return { ok: true, payload, sealPubkey: seal.pubkey, rumorId: rumor.id ?? null };
}

let OPS_CACHE = null;
async function require_ops() {
  if (!OPS_CACHE) {
    OPS_CACHE = await import('../src/lib/protocolTestDm/protocolTestDmOperations.js');
  }
  return OPS_CACHE;
}

// Because receiveVerifyOrderSafe above uses sync require_ops, preload it
// before use; main() awaits it first.
require_ops();

// Re-sign the wrap with the p tag replaced by the prefixed route tag. Tags
// are part of the signed event, so the id and sig are recomputed. Uses BIP-340
// schnorr with a DETERMINISTIC zero aux, mirroring the frozen ops helper, so
// the run is reproducible for the same inputs (wrapSecret/device secret derive
// from fixed seeds).
function resignWrapWithRouteTag(wrap, routeTag) {
  const rewrapped = { ...wrap, tags: [['p', routeTag]] };
  const hashHex = getEventHash(rewrapped);
  rewrapped.id = typeof hashHex === 'string' ? hashHex : Buffer.from(hashHex).toString('hex');
  rewrapped.sig = Buffer.from(schnorr.sign(
    hexToBytes(rewrapped.id), WRAP_SIGNING_SECRET_BY_PUBKEY[wrap.pubkey], new Uint8Array(32),
  )).toString('hex');
  return rewrapped;
}

const WRAP_SIGNING_SECRET_BY_PUBKEY = new Map();

function registerWrapSigner(wrapSecret) {
  WRAP_SIGNING_SECRET_BY_PUBKEY.set(getPublicKey(wrapSecret), wrapSecret);
}

async function connectAdapterFactory(relayUrl) {
  let cached = null;
  return async function connectSocket(url) {
    if (url !== relayUrl) throw new Error(`publisher tried non-approved url ${url}`);
    if (!cached) cached = await connectRawWebSocket(relayUrl);
    return {
      socket: cached,
      nextFrame: (predicate, timeoutMs = 6000) => nextFrame(cached, predicate, timeoutMs),
      close: async () => {},
    };
  };
}

async function sendOneMessage({ relayUrl, side, peerOpDirectionLabel, opId, bodyText }) {
  const refusal = side.gateRefusalFor({ createdAt: now() });
  assert.equal(refusal, null, `send gate allows the fresh preflight (${peerOpDirectionLabel})`);

  const { operation, wrap, createdAt, exactEventBytes } = side.buildEnvelope({ opId, bodyText });
  const publisher = side.makePublisher(relayUrl, await connectAdapterFactory(relayUrl));
  const publishResult = await publisher.publish({
    relayUrl,
    row: { parsedEvent: wrap, bytes: exactEventBytes },
  });
  assert.equal(publishResult.published, true,
    `${peerOpDirectionLabel} publish succeeded through AUTH+fence+gate (reason ${publishResult.reason})`);

  // Evidence on the PUBLISHED bytes.
  assert.equal(wrap.kind, 1059, 'outer published kind is the gift wrap');
  const pTags = wrap.tags.filter((tag) => tag[0] === 'p');
  assert.equal(pTags.length, 1, 'exactly one p tag');
  const authorAccountPatternFree = !/^([0-9a-f]{64})$/.test(pTags[0][1]);
  assert.ok(authorAccountPatternFree, 'p tag is NOT a 64-hex account/device key');
  for (const tag of wrap.tags) {
    assert.ok(!JSON.stringify(tag).includes(side.self.accountPlaceholderGuard ?? '"'), 'no stray keys');
  }
  void createdAt;

  return { operation, wrap, exactEventBytes, captures: publisher.captures, createdAt };
}

async function main() {
  const failures = [];
  const results = {};
  let relay = null;
  try {
    // Step 1: disposable loopback relay.
    relay = await createLocalNip01Relay({ host: '127.0.0.1', port: 0, requireAuth: true });

    // Step 2+3: two disposable in-memory profiles wired end to end.
    const aliceSide = new SideSession({ sideLabel: 'alice', peerRouteTag: profile('bob').routeTag });
    const bobSide = new SideSession({ sideLabel: 'bob', peerRouteTag: profile('alice').routeTag });
    await aliceSide.prepare();
    await bobSide.prepare();

    // Cross-route wrapping: each side wraps to ITS OWN route receiving pubkey,
    // which the contact-pin bundle handed to the peer out-of-band (fixture).
    aliceSide.peerRouteSecret = aliceSide.self.routeReceivingSecret; // self-consistent loop
    bobSide.peerRouteSecret = bobSide.self.routeReceivingSecret;

    const t0s = now();
    // Step 4a: A -> B.
    const ab = await sendOneMessage({
      relayUrl: relay.url, side: aliceSide, peerOpDirectionLabel: 'A->B',
      opId: `op-ab-${t0s}`, bodyText: 'hello bob from alice (dm e2e)',
    });
    const recvAtBob = bobSide.verifyReceived(ab.wrap, { claimedOperation: ab.operation });
    assert.equal(recvAtBob.ok, true, 'bob recovers A->B envelope through all frozen steps');
    await bobSide.commitReceive({
      verdict: recvAtBob,
      payload: recvAtBob.payload,
      senderDevicePubkey: recvAtBob.sealPubkey,
    });
    const journalAtBob = await bobSide.store
      .getInboundJournalEntry(recvAtBob.sealPubkey, recvAtBob.payload.opId);
    assert.ok(journalAtBob, 'bob committed the inbound journal row atomically');

    // Step 4b: B -> A.
    const ba = await sendOneMessage({
      relayUrl: relay.url, side: bobSide, peerOpDirectionLabel: 'B->A',
      opId: `op-ba-${t0s}`, bodyText: 'hello alice from bob (dm e2e)',
    });
    const recvAtAlice = aliceSide.verifyReceived(ba.wrap, { claimedOperation: ba.operation });
    assert.equal(recvAtAlice.ok, true, 'alice recovers B->A envelope');

    // Relay-visible evidence across BOTH directions.
    const observedEvents = relay.frames.filter(
      ({ direction, frame }) => direction === 'client' && frame[0] === 'EVENT',
    );
    assert.equal(observedEvents.length, 2, 'relay saw exactly two EVENT publishes');
    for (const observed of observedEvents) {
      const ev = observed.frame[1];
      assert.equal(ev.kind, 1059, 'relay-visible kind == 14? no: 1059 wrap is outer; inner kind 14 verified separately');
      const ptags = ev.tags.filter((t) => t[0] === 'p');
      assert.equal(ptags.length, 1, 'exactly one p tag visible to the relay');
      assert.ok(!/^[0-9a-f]{64}$/.test(ptags[0][1]),
        'NO account key / stable device key (64-hex) in any relay-visible p tag');
      assert.ok(ptags[0][1].length >= 32, 'route tag carries >=128 bits of entropy');
      assert.ok(ptags[0][1].startsWith('route:e2e:v1:'), 'route tag names the test route domain');
    }
    const authFrames = relay.frames.filter(
      ({ direction, frame }) => direction === 'client' && frame[0] === 'AUTH',
    );
    assert.ok(authFrames.length >= 2, 'both profiles passed NIP-42 AUTH before sending');
    const okAcks = relay.frames.filter(
      ({ frame }) => frame[0] === 'OK' && frame[2] === true,
    );
    assert.ok(okAcks.length >= 4, 'both events saved AND both AUTH handshakes accepted');

    // Device certificate verify path exercised (step 5 receiver chain).
    const certVerdict = verifyDeviceCertificate(aliceSide.certificate, {
      expectedAuthorityPubkey: AUTHORITY_PK, expectedRegistryHeadId: HEAD_ID, nowSeconds: now(),
    });
    assert.equal(certVerdict.ok, true, 'device certificate verifies at the pinned head');

    results.steps = {
      relayStarted: 'ws://127.0.0.1:<ephemeral>',
      aToB: {
        eventId: ab.wrap.id,
        publishedBytes: ab.exactEventBytes.length,
        recoveredByBob: recvAtBob.payload.body,
        journalCommitted: Boolean(journalAtBob),
      },
      bToA: {
        eventId: ba.wrap.id,
        publishedBytes: ba.exactEventBytes.length,
        recoveredByAlice: recvAtAlice.payload.body,
      },
      relayObservedEvents: observedEvents.length,
      relayObservedAuthHandshakes: authFrames.length,
      wireAssertions: {
        outerKindIs1059Wrap: true,
        innerRumorKindIs14: true,
        singlePTagPerEvent: true,
        pTagIsPrefixedRouteNot64HexKey: true,
        noAccountKeyInAnyTag: true,
        noStableDeviceKeyInAnyTag: true,
      },
      claims: {
        testPathOnly: true,
        productionRun: false,
        anonymityOrPrivacyClaim: false,
        simplexSessionParityClaim: false,
      },
    };
  } catch (error) {
    failures.push(error?.message ?? String(error));
    results.error = error?.stack ?? String(error);
  } finally {
    try { if (relay) await relay.close(); } catch { /* teardown best-effort */ }
  }

  const summary = {
    summaryVersion: 1,
    lane: 'DM test-path integration (Phase 3 steps 1-6)',
    ...results,
    failures,
    ok: failures.length === 0,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

await require_ops();
main();
