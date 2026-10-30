import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCallTransport, callsAvailable, getCallSnapshot, handleCallSignal, startCall } from './voiceCall.js';

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
  await handleCallSignal({ data: { type: 'call', action: 'offer', callId: 'live', sdp: {} }, from: 'peer-c', known: true, createdAt: Math.floor(Date.now() / 1000) });
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

test('a stranger\'s call offer gets silence, not a signed reject', async () => {
  const sent = [];
  bindCallTransport(async (peer, payload) => { sent.push({ peer, payload }); return { success: true }; });
  const offer = { type: 'call', action: 'offer', callId: 'probe', sdp: {} };
  const now = Math.floor(Date.now() / 1000);
  await handleCallSignal({ data: offer, from: 'stranger', createdAt: now });
  await handleCallSignal({ data: offer, from: 'stranger', known: false, createdAt: now });
  await handleCallSignal({ data: offer, from: 'stranger', known: 'yes', createdAt: now });
  assert.equal(sent.length, 0);
  await handleCallSignal({ data: offer, from: 'friend', known: true, createdAt: now });
  assert.equal(sent.length, 1);
});

test('a call signal a relay held too long is dropped without a reply', async () => {
  const sent = [];
  bindCallTransport(async (peer, payload) => { sent.push({ peer, payload }); return { success: true }; });
  const offer = { type: 'call', action: 'offer', callId: 'replayed', sdp: {} };
  const now = Math.floor(Date.now() / 1000);

  // Fresh: still one polite reject.
  await handleCallSignal({ data: offer, from: 'friend', known: true, createdAt: now });
  assert.equal(sent.length, 1);

  // A minute and one second old, or hours old: dead on arrival, no reply.
  await handleCallSignal({ data: offer, from: 'friend', known: true, createdAt: now - 61 });
  await handleCallSignal({ data: offer, from: 'friend', known: true, createdAt: now - 3600 });
  assert.equal(sent.length, 1);

  // No readable timestamp at all: nothing can prove it is fresh.
  await handleCallSignal({ data: offer, from: 'friend', known: true, createdAt: undefined });
  await handleCallSignal({ data: offer, from: 'friend', known: true, createdAt: 'yesterday' });
  assert.equal(sent.length, 1);
});

// The UI reads one flag to decide whether a call door exists at all. It must
// never disagree with the module's own refusal: a screen that hides the button
// and a startCall that says no are the same fact, stated once.
test('the UI flag and the refusal are the same fact', async () => {
  assert.equal(callsAvailable, false);
  const started = await startCall({ peer: 'peer-a', name: 'Test' });
  assert.equal(started.ok, false);
  assert.match(started.error, /Calls are off/);
});
