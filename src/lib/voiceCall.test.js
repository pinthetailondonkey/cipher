import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCallTransport, getCallSnapshot, handleCallSignal, startCall } from './voiceCall.js';

// Calls are off in every build (docs/NO-IP-LEAKS.md). The module keeps the
// shape an old peer knows: an offer gets a polite reject, nothing ever rings,
// and nothing ever forms an RTCPeerConnection — there are no candidates left
// to gather, so no real IP rides the wire.
test('calls are off: an offer is refused, nothing rings, nothing routes', async () => {
  const sent = [];
  bindCallTransport(async (peer, payload) => { sent.push({ peer, payload }); return { success: true }; });

  const started = await startCall({ peer: 'peer-a', name: 'Test' });
  assert.equal(started.ok, false);
  assert.match(started.error, /Calls are off/);
  assert.equal(getCallSnapshot(), null);

  // A live offer from a modern or old peer: one reject back, no session, no ring.
  await handleCallSignal({ data: { type: 'call', action: 'offer', callId: 'live', sdp: {} }, from: 'peer-c' });
  assert.equal(getCallSnapshot(), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.action, 'reject');
  assert.equal(sent[0].peer, 'peer-c');
  assert.equal(sent[0].payload.callId, 'live');

  // Non-offer signal kinds are ignored without a reply.
  await handleCallSignal({ data: { type: 'call', action: 'ice', callId: 'live', candidate: {} }, from: 'peer-c' });
  await handleCallSignal({ data: { type: 'call', action: 'answer', callId: 'live', sdp: {} }, from: 'peer-c' });
  await handleCallSignal({ data: { type: 'call', action: 'offer' }, from: '' });
  assert.equal(sent.length, 1);
});
