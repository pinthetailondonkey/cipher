// Send-side freshness gate (TEST-ONLY, src/lib/protocolTestDm/).
//
// Frozen spec: docs/DM-TEST-PROFILE-V1.md section 2 ("Send-time freshness
// gate") and protocol build plan v2 broken item 3. All four conditions must
// hold at the moment of the socket send:
//   G1 checkpointAuthenticated - sender holds a locally authenticated
//      authority checkpoint (policy event + registry head chain, not a bare
//      relay snapshot).
//   G2 headAgeVerdict(pinnedHeadCreatedAt, now) == 'fresh' - pinned registry
//      head age <= D3 REGISTRY_MAX_AGE_SECONDS (86400s; exactly-at-boundary
//      is fresh).
//   G3 targetDeviceActiveAtHead - target device listed active in that head.
//   G4 socketAuthed - freshly connected relay socket passed NIP-42 AUTH for
//      the sending route identity immediately before send.
//
// This module is a PURE decision function plus a thin recheck wrapper used by
// testPublisher.js between AUTH and EVENT. It mutates nothing and touches no
// production messaging path. Reject reasons are stable strings so the e2e
// driver and journal tests can assert them.

import { REGISTRY_MAX_AGE_SECONDS, headAgeVerdict } from './protocolTestDmOperations.js';

export const SEND_GATE_REJECT_REASONS = Object.freeze({
  NO_CHECKPOINT: 'no-authenticated-checkpoint',
  MISSING_HEAD_TIME: 'pinned-head-timestamp-missing',
  INVALID_HEAD_TIME: 'pinned-head-timestamp-invalid',
  STALE_HEAD: 'stale-pinned-registry-head',
  TARGET_INACTIVE: 'target-device-not-active-at-head',
  TARGET_UNKNOWN: 'target-device-unknown-at-head',
  SOCKET_NOT_AUTHED: 'socket-not-authenticated',
});

export const SEND_GATE_CONSTANTS = Object.freeze({
  REGISTRY_MAX_AGE_SECONDS,
});

function reject(reason, extra = {}) {
  return { allow: false, reason, ...extra };
}

export function sendGateDecision({
  checkpointAuthenticated,
  pinnedHeadCreatedAtSeconds,
  nowSeconds,
  targetDeviceActive,
  targetKnownAtHead,
  socketAuthed,
}) {
  if (!checkpointAuthenticated) return reject(SEND_GATE_REJECT_REASONS.NO_CHECKPOINT);
  if (!(typeof pinnedHeadCreatedAtSeconds === 'number')) {
    return reject(SEND_GATE_REJECT_REASONS.MISSING_HEAD_TIME);
  }
  const headVerdict = headAgeVerdict(pinnedHeadCreatedAtSeconds, nowSeconds);
  // D3 boundary semantics come from headAgeVerdict: exactly 24h old is fresh,
  // one second past is stale, malformed input names itself.
  if (headVerdict === 'invalid-head') {
    const nonInteger = Number.isFinite(pinnedHeadCreatedAtSeconds)
      && !Number.isSafeInteger(pinnedHeadCreatedAtSeconds);
    return reject(nonInteger ? SEND_GATE_REJECT_REASONS.INVALID_HEAD_TIME : SEND_GATE_REJECT_REASONS.MISSING_HEAD_TIME);
  }
  if (headVerdict === 'stale-registry-head') {
    return reject(SEND_GATE_REJECT_REASONS.STALE_HEAD,
      { headAgeSeconds: nowSeconds - pinnedHeadCreatedAtSeconds });
  }
  if (!targetKnownAtHead) return reject(SEND_GATE_REJECT_REASONS.TARGET_UNKNOWN);
  if (!targetDeviceActive) return reject(SEND_GATE_REJECT_REASONS.TARGET_INACTIVE);
  if (!socketAuthed) return reject(SEND_GATE_REJECT_REASONS.SOCKET_NOT_AUTHED);
  return { allow: true, reason: null };
}

// Recheck used by the publisher AFTER connect+AUTH, immediately before
// socket.send of EXACT event bytes. Only clock-dependent facts are re-evaluated
// here; the caller passes its current pinned head + device status snapshot.
export function recheckFreshnessAtSend({ decisionInputs }) {
  return sendGateDecision(decisionInputs);
}
