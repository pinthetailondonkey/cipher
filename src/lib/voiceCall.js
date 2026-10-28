// Voice calls are OFF — the founder's decision, everywhere, every build.
//
// Why: a WebRTC call is a direct link between two devices, so every call
// hands each side the other side's real IP (the candidates inside the offer
// and answer), and the call-routing hosts see both pairs of addresses too.
// Under the no-IP-leak law (docs/NO-IP-LEAKS.md) no path here can pass, so
// none of it ships: no WebRTC peer, no microphone, no ring, no candidates —
// nothing can ever form.
//
// What stays behind: the shape of the module, so a re-enable is a real
// design decision and not a forgotten stub. See the Calls section in
// docs/NO-IP-LEAKS.md for what a sound re-enable would have to build on
// (Tor-routed relay only, or a STUN-free design — documented shut door).

const CALLS_OFF = 'Calls are off in this app. Messages still work everywhere calls ever did.';

let transport = async () => {};

export function bindCallTransport(send) {
  // Kept so the DM hook can still wire its side of the wall; nothing ever
  // sends through it while calls are off.
  transport = typeof send === 'function' ? send : async () => {};
}

export function subscribeCall(listener) {
  // The overlay used to subscribe here. With calls off there is no session,
  // ever, so it gets the same null it saw on a fresh open.
  listener(null);
  return () => {};
}

export function getCallSnapshot() {
  return null;
}

export async function startCall() {
  return { ok: false, error: CALLS_OFF };
}

export async function acceptCall() {}

export async function hangup() {}

export function toggleMute() {}

// Old peers may still ring us with a call offer. Answering silence would leave
// their side ringing until it gives up — so a person we already talk to (the
// caller passes known: true only when we have sent them a message) is politely
// refused and learns the same thing this screen does: calls are off here.
// A stranger gets nothing. A signed reply to a stranger's offer would tell
// them our key is live and online, and would open a connection to their
// relays on their say-so.
export async function handleCallSignal({ data, from, known = false }) {
  if (!data || data.action !== 'offer' || !from || known !== true) return;
  try { await transport(from, { type: 'call', callId: data.callId, action: 'reject', reason: 'privacy' }); }
  catch { }
}
