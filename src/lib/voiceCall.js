import { getPrivacy } from './privacy';
import { iceServers } from './egress';

const LIVE = new Set(['calling', 'ringing', 'connecting', 'active']);

let transport = async () => {};
let session = null;
const listeners = new Set();
const seenEvents = new Set();
const earlyIce = new Map();
let ringTimer = null;
let audioCtx = null;

function emit() {
  listeners.forEach((listener) => listener());
}

function patch(next) {
  session = { ...session, ...next };
  emit();
}

export function bindCallTransport(send) {
  transport = typeof send === 'function' ? send : async () => {};
}

export function subscribeCall(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCallSnapshot() {
  return session;
}

async function signal(peer, payload) {
  if (!peer) return;
  try {
    await transport(peer, { type: 'call', ...payload });
  } catch (error) {
    console.warn('[call] Signal failed:', error);
  }
}

async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot place voice calls.');
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false,
  });
}

function openPeer() {
  const servers = iceServers();
  if (!servers.length) throw new Error('Calls need a route. The built-in ones are off, and no call relay is set.');
  return new RTCPeerConnection({ iceServers: servers });
}

function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 480;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.24);
  } catch (error) {
    console.warn('[call] Ringtone unavailable:', error);
  }
}

function startRing() {
  stopRing();
  beep();
  ringTimer = setInterval(beep, 1600);
}

function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

function attachRemoteAudio(pc) {
  const audio = new Audio();
  audio.autoplay = true;
  audio.setAttribute('playsinline', 'true');
  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    audio.play().catch(() => {});
  };
  return audio;
}

async function flushIce(current) {
  if (!current?.pc?.remoteDescription) return;
  const queued = current.pendingIce || [];
  current.pendingIce = [];
  for (const candidate of queued) {
    try {
      await current.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('[call] ICE candidate dropped:', error);
    }
  }
}

function holdIce(callId, candidate) {
  if (!candidate) return;
  if (session?.callId === callId) {
    session.pendingIce = [...(session.pendingIce || []), candidate];
    return;
  }
  const queued = earlyIce.get(callId) || [];
  queued.push(candidate);
  earlyIce.set(callId, queued);
}

function teardown(current) {
  stopRing();
  current?.local?.getTracks().forEach((track) => track.stop());
  try { current?.pc?.close(); } catch {}
  if (current?.remoteAudio) current.remoteAudio.srcObject = null;
}

function finish(status) {
  if (!session) return;
  const endingId = session.callId;
  teardown(session);
  session = { ...session, status, pc: null, local: null, remoteAudio: null };
  emit();
  const ended = session;
  setTimeout(() => {
    if (session === ended) {
      session = null;
      earlyIce.delete(endingId);
      emit();
    }
  }, 1400);
}

export async function startCall({ peer, name }) {
  if (!peer) return { ok: false, error: 'Open a chat before calling.' };
  if (session && LIVE.has(session.status)) return { ok: false, error: 'You are already in a call.' };
  const callId = crypto.randomUUID();
  try {
    const local = await openMicrophone();
    const pc = openPeer();
    local.getTracks().forEach((track) => pc.addTrack(track, local));
    const remoteAudio = attachRemoteAudio(pc);
    session = {
      callId, peer, name: name || 'Voice call', direction: 'out', status: 'calling',
      pc, local, remoteAudio, muted: false, startedAt: null, pendingIce: earlyIce.get(callId) || [],
    };
    earlyIce.delete(callId);
    emit();
    startRing();
    pc.onicecandidate = (event) => {
      if (event.candidate) signal(peer, { action: 'ice', callId, candidate: event.candidate.toJSON() });
    };
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await signal(peer, { action: 'offer', callId, sdp: pc.localDescription });
    return { ok: true };
  } catch (error) {
    console.error('[call] Could not start:', error);
    if (session?.callId === callId) finish('ended');
    const denied = error?.name === 'NotAllowedError' || error?.name === 'NotFoundError';
    return { ok: false, error: denied ? 'Allow microphone access to place a call.' : (error?.message || 'Could not start the call.') };
  }
}

export async function acceptCall() {
  if (!session || session.direction !== 'in' || session.status !== 'ringing') return;
  const callId = session.callId;
  const peer = session.peer;
  const offer = session.offer;
  patch({ status: 'connecting' });
  try {
    const local = await openMicrophone();
    const pc = openPeer();
    local.getTracks().forEach((track) => pc.addTrack(track, local));
    const remoteAudio = attachRemoteAudio(pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) signal(peer, { action: 'ice', callId, candidate: event.candidate.toJSON() });
    };
    patch({ pc, local, remoteAudio });
    await pc.setRemoteDescription(offer);
    await flushIce(session);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await signal(peer, { action: 'answer', callId, sdp: pc.localDescription });
    stopRing();
    patch({ status: 'active', startedAt: Date.now() });
  } catch (error) {
    console.error('[call] Could not answer:', error);
    await signal(peer, { action: 'reject', callId });
    if (session?.callId === callId) finish('ended');
  }
}

export async function hangup() {
  if (!session) return;
  const { peer, callId, status, direction } = session;
  const action = (status === 'ringing' || status === 'connecting') && direction === 'in' ? 'reject' : 'hangup';
  await signal(peer, { action, callId });
  finish(action === 'reject' ? 'declined' : 'ended');
}

export function toggleMute() {
  if (!session?.local) return;
  const muted = !session.muted;
  session.local.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  patch({ muted });
}

// The live DM subscription replays a week of history on every launch. A call
// signal older than this is history, not a call: it neither rings nor gets a
// busy or reject sent back to whoever placed it.
export const CALL_SIGNAL_MAX_AGE_SEC = 60;

export function isStaleCallSignal(createdAt, now = Math.floor(Date.now() / 1000)) {
  return Number.isFinite(createdAt) && now - createdAt > CALL_SIGNAL_MAX_AGE_SEC;
}

export async function handleCallSignal({ data, from, eventId, createdAt }) {
  if (!data?.callId || !from) return;
  if (eventId) {
    if (seenEvents.has(eventId)) return;
    seenEvents.add(eventId);
    if (seenEvents.size > 400) seenEvents.clear();
  }
  if (isStaleCallSignal(createdAt)) return;
  if (data.action === 'ice') {
    if (session?.callId === data.callId && session.pc?.remoteDescription) {
      try { await session.pc.addIceCandidate(data.candidate); }
      catch (error) { console.warn('[call] ICE candidate dropped:', error); }
      return;
    }
    holdIce(data.callId, data.candidate);
    return;
  }
  if (data.action === 'offer') {
    if (session?.callId === data.callId) return;
    if (getPrivacy().calls === 'nobody') {
      await signal(from, { action: 'reject', callId: data.callId, reason: 'privacy' });
      return;
    }
    if (session && LIVE.has(session.status)) {
      await signal(from, { action: 'busy', callId: data.callId });
      return;
    }
    session = {
      callId: data.callId, peer: from, name: '', direction: 'in', status: 'ringing',
      offer: data.sdp, pc: null, local: null, remoteAudio: null, muted: false,
      pendingIce: earlyIce.get(data.callId) || [],
    };
    earlyIce.delete(data.callId);
    emit();
    startRing();
    return;
  }
  if (!session || session.callId !== data.callId) return;
  if (data.action === 'answer') {
    if (!session.pc || session.status === 'active') return;
    try {
      await session.pc.setRemoteDescription(data.sdp);
      await flushIce(session);
      stopRing();
      patch({ status: 'active', startedAt: Date.now() });
    } catch (error) {
      console.error('[call] Could not apply the answer:', error);
    }
    return;
  }
  if (data.action === 'busy' || data.action === 'reject' || data.action === 'hangup') {
    if (session.status === 'active' && data.action === 'busy') return;
    const status = data.reason === 'privacy' ? 'restricted' : data.action === 'busy' ? 'busy' : data.action === 'reject' ? 'declined' : 'ended';
    finish(status);
  }
}
