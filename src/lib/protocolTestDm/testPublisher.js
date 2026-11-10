// Test-mode publisher (TEST-ONLY, src/lib/protocolTestDm/testPublisher.js).
//
// Frozen spec: docs/DM-TEST-PROFILE-V1.md sections 1 and 6; protocol build
// plan v2 broken item 4. Contract:
// - Connects ONLY to relay URLs passed in explicitly by the caller. The
//   default allowlist is EMPTY: nothing is allowed unless the caller names it.
//   This module never invents, discovers or falls back to any relay.
// - Publish sequence per attempt: connect -> NIP-42 AUTH (via an injected
//   auth event builder bound to the sending route identity) -> freshness
//   recheck via sendGateDecision -> fence check (caller-supplied predicate,
//   e.g. local security-context incarnation still current) -> SYNCHRONOUS
//   socket.send of EXACT pre-built event bytes. No re-encryption, no
//   re-signing, no timestamp refresh between retries (DMV1-013).
// - Refuses protocol rows whose outer event kind != WRAP_KIND (1059);
//   a p tag matching a 64-hex account/device key pattern is REFUSED as a route
//   tag (route pubkeys are >=128 bits with their own prefix domain chosen by
//   lane R; 64-hex nostr pubkeys are keys that could correlate identities).
// - Retries resend IDENTICAL byte payloads after reconnect.
// - Every frame (client and relay direction) is recorded into `captures` for
//   evidence.

import { finalizeEvent } from 'nostr-tools/pure';

export const PUBLISHER_CONSTANTS = Object.freeze({
  WRAP_KIND: 1059,
});

const HEX64 = /^[0-9a-f]{64}$/;

export function createTestPublisher({
  allowedRelayUrls = [], // DEFAULT DENY LIST: nothing allowed until named here
  buildAuthEvent, // async ({relayUrl, challenge}) => signed kind 22242 event
  securityFenceCheck, // () => boolean; account fence alive at send time
  connectSocket, // async (url) => {socket, nextFrame, close} adapter
  sendGateInputs, // () => gate decision inputs EXCEPT socketAuthed
  clockMs = () => Date.now(),
}) {
  if (!Array.isArray(allowedRelayUrls)) {
    throw new Error('allowedRelayUrls must be an array (default deny list).');
  }
  const allowlist = new Set(allowedRelayUrls);
  const captures = [];

  const refuse = (reason) => ({ published: false, reason });

  function recordCapture(direction, entry) {
    captures.push({ atMs: clockMs(), direction, ...entry });
  }

  function validateRow(rowOrBytes) {
    if (rowOrBytes == null || typeof rowOrBytes !== 'object') {
      return refuse('publisher-row-invalid');
    }
    // Accept either a full parsed wrap event plus bytes, or a byte-carrying row.
    const parsedEvent = rowOrBytes.parsedEvent ?? (() => {
      try { return JSON.parse(typeof rowOrBytes.bytes === 'string' ? rowOrBytes.bytes : ''); } catch { return null; }
    })();
    if (!parsedEvent) return refuse('publisher-row-unparseable');
    if (parsedEvent.kind !== PUBLISHER_CONSTANTS.WRAP_KIND) {
      return refuse(`publisher-refused-kind-${parsedEvent.kind}`);
    }
    const pTags = (parsedEvent.tags || []).filter((tag) => tag[0] === 'p');
    if (pTags.length !== 1) return refuse('publisher-route-tag-not-exactly-one');
    const routeTag = pTags[0][1];
    if (typeof routeTag !== 'string' || routeTag.length < 32) {
      return refuse('publisher-route-tag-too-short');
    }
    // Account key pattern (64-hex secp256k1 x-only pubkey): rejected as a route
    // tag. Route keys come from lane R derivation and never equal these.
    if (HEX64.test(routeTag)) {
      return refuse('publisher-account-key-pattern-as-route-tag');
    }
    return { ok: true, parsedEvent };
  }

  async function publishOnce(relayUrl, rowOrBytes) {
    const verdict = validateRow(rowOrBytes);
    if (verdict.ok !== true) return verdict;
    const bytesToSend = typeof rowOrBytes.bytes === 'string'
      ? rowOrBytes.bytes : JSON.stringify(['EVENT', verdict.parsedEvent]);

    const connection = await connectSocket(relayUrl);
    let authOk = false;
    try {
      // AUTH handshake when the relay challenges (NIP-42).
      const firstFrame = await connection.nextFrame((text) => text.startsWith('["AUTH"') || text.startsWith('["OK"'));
      if (firstFrame.startsWith('["AUTH"')) {
        const challenge = JSON.parse(firstFrame)[1];
        const authEvent = await buildAuthEvent({ relayUrl, challenge });
        connection.socket.send(JSON.stringify(['AUTH', authEvent]));
        const authAck = await connection.nextFrame((text) => text.startsWith('["OK"'));
        authOk = JSON.parse(authAck)[2] === true;
        recordCapture('auth-result', { relayUrl, ok: authOk });
        if (!authOk) return { published: false, reason: 'auth-rejected-by-relay' };
        // Freshness RECHECK after any AUTH exchange (gate runs again now).
        const inputs = { ...sendGateInputs(), socketAuthed: true };
        const gateNow = (await import('./sendGate.js')).sendGateDecision(inputs);
        if (!gateNow.allow) return { published: false, reason: `freshness-at-send:${gateNow.reason}` };
        // Fence check immediately before socket.send.
        if (!(await securityFenceCheck())) return { published: false, reason: 'security-fence-invalidated' };
        connection.socket.send(bytesToSend); // SYNC socket.send of EXACT bytes
        const ack = await connection.nextFrame((text) => text.startsWith(`["OK","${verdict.parsedEvent.id}"`));
        recordCapture('event-ack', { relayUrl, ackText: ack });
        return { published: true, ackText: ack, bytesSent: bytesToSend };
      }
      // No AUTH required path: go straight through gate+fence+send.
      const inputs = { ...sendGateInputs(), socketAuthed: true };
      const gateNow = (await import('./sendGate.js')).sendGateDecision(inputs);
      if (!gateNow.allow) return { published: false, reason: `freshness-at-send:${gateNow.reason}` };
      if (!(await securityFenceCheck())) return { published: false, reason: 'security-fence-invalidated' };
      connection.socket.send(bytesToSend);
      const ack = await connection.nextFrame((text) => text.startsWith(`["OK","${verdict.parsedEvent.id}"`));
      recordCapture('event-ack', { relayUrl, ackText: ack });
      return { published: true, ackText: ack, bytesSent: bytesToSend };
    } finally {
      await connection.close();
    }
  }

  return {
    captures,

    canUseRelay(url) { return allowlist.has(url); },

    async publish({ relayUrl, row }) {
      if (!allowlist.has(relayUrl)) {
        return refuse(`relay-not-allowlisted:${relayUrl}`);
      }
      const gateInputs = sendGateInputs();
      // Pre-flight gate WITHOUT claiming socket auth yet; publishOnce does the
      // authoritative post-AUTH recheck.
      const preFlight = (await import('./sendGate.js')).sendGateDecision(
        { ...gateInputs, socketAuthed: true },
      );
      if (!preFlight.allow) {
        recordCapture('preflight-refusal', { relayUrl, reason: preFlight.reason });
        return { published: false, reason: `freshness-preflight:${preFlight.reason}` };
      }
      recordCapture('publish-attempt', { relayUrl, eventId: row?.parsedEvent?.id ?? null });
      return publishOnce(relayUrl, row);
    },

    // Retry: resends the IDENTICAL bytes captured from the prior successful
    // OR failed send (DMV1-013). Never rebuilds the payload.
    async retryIdenticalBytes({ relayUrl, row }) {
      if (!allowlist.has(relayUrl)) {
        return refuse(`relay-not-allowlisted:${relayUrl}`);
      }
      const first = row.firstAttemptBytes ?? row.bytes ?? null;
      if (typeof first !== 'string' || !first.includes('"EVENT"')) {
        return refuse('retry-missing-original-bytes');
      }
      recordCapture('retry-attempt', { relayUrl, bytesPreviewLength: first.length });
      return publishOnce(relayUrl, { ...row, bytes: first, parsedEvent: row.parsedEvent });
    },
  };
}

// Re-exported for tests: NIP-42 AUTH event builder bound to a route identity.
// Uses nostr-tools pure signing; the auth event carries relay + challenge tags
// per NIP-42 and is signed by the SENDING ROUTE secret, never an account key.
export function buildNip42AuthEvent({ routeSecretKeyHex, relayUrl, challenge }) {
  const secretBytes = Buffer.from(routeSecretKeyHex, 'hex');
  return finalizeEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', relayUrl], ['challenge', challenge]],
    content: '',
  }, secretBytes);
}

