import assert from 'node:assert/strict';
import test from 'node:test';
import { CALL_SIGNAL_MAX_AGE_SEC, bindCallTransport, getCallSnapshot, handleCallSignal, isStaleCallSignal } from './voiceCall.js';

test('a replayed call offer from history does not ring and sends nothing back', async () => {
  const sent = [];
  bindCallTransport(async (peer, payload) => { sent.push({ peer, payload }); return { success: true }; });
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isStaleCallSignal(now - CALL_SIGNAL_MAX_AGE_SEC - 1, now), true);
  assert.equal(isStaleCallSignal(now - 5, now), false);
  assert.equal(isStaleCallSignal(undefined, now), false);

  await handleCallSignal({ data: { type: 'call', action: 'offer', callId: 'old', sdp: {} }, from: 'peer-a', eventId: 'e-old', createdAt: now - 86400 });
  assert.equal(getCallSnapshot(), null);
  // A second old offer would have been answered busy while the first rang.
  await handleCallSignal({ data: { type: 'call', action: 'offer', callId: 'older', sdp: {} }, from: 'peer-b', eventId: 'e-older', createdAt: now - 3600 });
  assert.equal(getCallSnapshot(), null);
  assert.deepEqual(sent, []);

  await handleCallSignal({ data: { type: 'call', action: 'offer', callId: 'live', sdp: {} }, from: 'peer-c', eventId: 'e-live', createdAt: now });
  assert.equal(getCallSnapshot()?.status, 'ringing');
  await handleCallSignal({ data: { type: 'call', action: 'hangup', callId: 'live' }, from: 'peer-c', eventId: 'e-hangup', createdAt: now });
  assert.equal(getCallSnapshot()?.status, 'ended');
});
