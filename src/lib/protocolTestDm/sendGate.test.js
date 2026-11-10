// Colocated focused test for src/lib/protocolTestDm/sendGate.js
// (TEST-PATH-ONLY). Covers EVERY reject reason plus exactly-at-boundary D3
// values. Boundary semantics for head age live in the frozen operations
// module (headAgeVerdict) and are re-proven here through the gate itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { REGISTRY_MAX_AGE_SECONDS } from './protocolTestDmOperations.js';
import {
  SEND_GATE_REJECT_REASONS,
  sendGateDecision,
} from './sendGate.js';

const T0 = 1760000000;
const HEAD_AT_T0 = T0; // pinned head created exactly now
const good = () => ({
  checkpointAuthenticated: true,
  pinnedHeadCreatedAtSeconds: HEAD_AT_T0,
  nowSeconds: T0,
  targetKnownAtHead: true,
  targetDeviceActive: true,
  socketAuthed: true,
});

test('a fully fresh gate allows the send', () => {
  const decision = sendGateDecision(good());
  assert.deepEqual(decision, { allow: true, reason: null });
});

test('reject: no authenticated authority checkpoint', () => {
  const decision = sendGateDecision({ ...good(), checkpointAuthenticated: false });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.NO_CHECKPOINT);
});

for (const bad of [null, undefined, 'now', Number.NaN]) {
  test(`reject: pinned head timestamp unusable (${String(bad)})`, () => {
    const decision = sendGateDecision({ ...good(), pinnedHeadCreatedAtSeconds: bad });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.MISSING_HEAD_TIME);
  });
}

test('reject: non-safe-integer head timestamp names itself', () => {
  const decision = sendGateDecision({ ...good(), pinnedHeadCreatedAtSeconds: 1.5 });
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.INVALID_HEAD_TIME);
});

test('reject: stale pinned registry head', () => {
  const decision = sendGateDecision({
    ...good(),
    pinnedHeadCreatedAtSeconds: T0 - REGISTRY_MAX_AGE_SECONDS - 1,
    nowSeconds: T0,
  });
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.STALE_HEAD);
  assert.equal(decision.headAgeSeconds, REGISTRY_MAX_AGE_SECONDS + 1);
});

test('D3 boundary: head exactly REGISTRY_MAX_AGE_SECONDS old is FRESH', () => {
  const decision = sendGateDecision({
    ...good(),
    pinnedHeadCreatedAtSeconds: T0 - REGISTRY_MAX_AGE_SECONDS,
    nowSeconds: T0,
  });
  assert.deepEqual(decision, { allow: true, reason: null });
});

test('D3 boundary: one second past is STALE', () => {
  const decision = sendGateDecision({
    ...good(),
    pinnedHeadCreatedAtSeconds: T0 - REGISTRY_MAX_AGE_SECONDS - 1,
    nowSeconds: T0,
  });
  assert.equal(decision.allow, false);
});

test('reject: target device unknown at the pinned head', () => {
  const decision = sendGateDecision({ ...good(), targetKnownAtHead: false });
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.TARGET_UNKNOWN);
});

test('reject: target device inactive at the pinned head', () => {
  const decision = sendGateDecision({ ...good(), targetDeviceActive: false });
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.TARGET_INACTIVE);
});

test('reject: socket not authenticated for the route identity', () => {
  const decision = sendGateDecision({ ...good(), socketAuthed: false });
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.SOCKET_NOT_AUTHED);
});

test('gate order: earlier checks fire before later ones fail-closed chain', () => {
  // Everything broken: first named reason is the first failing check.
  const decision = sendGateDecision({
    checkpointAuthenticated: false,
    pinnedHeadCreatedAtSeconds: null,
    nowSeconds: T0,
    targetKnownAtHead: false,
    targetDeviceActive: false,
    socketAuthed: false,
  });
  assert.equal(decision.reason, SEND_GATE_REJECT_REASONS.NO_CHECKPOINT);
});
