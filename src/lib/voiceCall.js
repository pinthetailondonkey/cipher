import { getPrivacy } from './privacy';

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let transport = async () => {};
let session = null;
const listeners = new Set();
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
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  remoteAudio.setAttribute('playsinline', 'true');
  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(() => {});
  };
  return remoteAudio;
}

async function flushIce(current) {
  const pending = current.pendingIce || [];
  current.pendingIce = [];
  for (const candidate of pending) {
    try { await current.pc.addIceCandidate(candidate); } catch (error) {
      console.warn('[call] ICE candidate dropped:', error);
    }
  }
}

function teardown(current) {
  stopRing();
  current?.local?.getTracks().forEach((track) => track.stop());
  try { current?.pc?.close(); } catch {}
  if (current?.remoteAudio) {
    current.remoteAudio.srcObject = null;
  }
}

function finish(status) {
  if (!session) return;
  teardown(session);
  session = { ...session, status, pc: null, local: null, remoteAudio: null };
  emit();
  const ended = session;
  setTimeout(() => {
    if (session === ended) {
      session = null;
      emit();
    }
  }, 1200);
}

export async function startCall({ peer, name }) {
  if (!peer) return { ok: false, error: 'Open a chat before calling.' };
  if (session && session.status !== 'ended') return { ok: false, error: 'You are already in a call.' };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, error: 'This browser cannot place voice calls.' };
  const callId = crypto.randomUUID();
  try {
    const local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const pc = new RTCPeerConnection({ iceServers });
    local.getTracks().forEach((track) => pc.addTrack(track, local));
    const remoteAudio = attachRemoteAudio(pc);
    session = {
      callId, peer, name: name || 'Voice call', direction: 'out', status: 'calling',
      pc, local, remoteAudio, muted: false, startedAt: null, pendingIce: [],
    };
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
    return { ok: false, error: denied ? 'Allow microphone access to place a call.' : 'Could not start the call.' };
  }
}

export async function acceptCall() {
  if (!session || session.direction !== 'in' || session.status !== 'ringing') return;
  try {
    const local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const pc = new RTCPeerConnection({ iceServers });
    local.getTracks().forEach((track) => pc.addTrack(track, local));
    const remoteAudio = attachRemoteAudio(pc);
    const current = session;
    current.pc = pc;
    current.local = local;
    current.remoteAudio = remoteAudio;
    pc.onicecandidate = (event) => {
      if (event.candidate) signal(current.peer, { action: 'ice', callId: current.callId, candidate: event.candidate.toJSON() });
    };
    await pc.setRemoteDescription(current.offer);
    await flushIce(current);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await signal(current.peer, { action: 'answer', callId: current.callId, sdp: pc.localDescription });
    stopRing();
    patch({ status: 'active', startedAt: Date.now(), pc, local, remoteAudio });
  } catch (error) {
    console.error('[call] Could not answer:', error);
    await signal(session?.peer, { action: 'reject', callId: session?.callId });
    finish('ended');
  }
}

export async function hangup() {
  if (!session) return;
  const { peer, callId, status, direction } = session;
  const action = status === 'ringing' && direction === 'in' ? 'reject' : 'hangup';
  await signal(peer, { action, callId });
  finish(action === 'reject' ? 'declined' : 'ended');
}

export function toggleMute() {
  if (!session?.local) return;
  const muted = !session.muted;
  session.local.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  patch({ muted });
}

export async function handleCallSignal({ data, from }) {
  if (!data?.callId || !from) return;
  if (data.action === 'offer') {
    if (getPrivacy().calls === 'nobody') {
      await signal(from, { action: 'reject', callId: data.callId, reason: 'privacy' });
      return;
    }
    if (session && session.status !== 'ended') {
      await signal(from, { action: 'busy', callId: data.callId });
      return;
    }
    session = {
      callId: data.callId, peer: from, name: '', direction: 'in', status: 'ringing',
      offer: data.sdp, pc: null, local: null, remoteAudio: null, muted: false, pendingIce: [],
    };
    emit();
    startRing();
    return;
  }
  if (!session || session.callId !== data.callId) return;
  if (data.action === 'answer' && session.pc) {
    await session.pc.setRemoteDescription(data.sdp);
    await flushIce(session);
    stopRing();
    patch({ status: 'active', startedAt: Date.now() });
    return;
  }
  if (data.action === 'ice' && data.candidate) {
    if (!session.pc?.remoteDescription) {
      session.pendingIce = [...(session.pendingIce || []), data.candidate];
      return;
    }
    try { await session.pc.addIceCandidate(data.candidate); } catch (error) {
      console.warn('[call] ICE candidate dropped:', error);
    }
    return;
  }
  if (data.action === 'busy' || data.action === 'reject' || data.action === 'hangup') {
    const status = data.reason === 'privacy' ? 'restricted' : data.action === 'busy' ? 'busy' : data.action === 'reject' ? 'declined' : 'ended';
    finish(status);
  }
}
