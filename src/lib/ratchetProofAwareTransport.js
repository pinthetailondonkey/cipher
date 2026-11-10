// Disabled-by-default transport seam for the isolated ratchet prototype.
// SimplePool defers WebSocket.send() until after connection/AUTH work, so an
// earlier caller-side freshness check cannot fence the actual handoff.
export class RatchetDeliveryHeld extends Error {
  constructor(message) {
    super(message);
    this.name = 'RatchetDeliveryHeld';
  }
}

function assertDeliveryCurrent({ freshUntil, now, assertCurrent }) {
  assertCurrent?.();
  if (!Number.isSafeInteger(freshUntil) || freshUntil <= Math.floor(now() / 1000)) {
    throw new RatchetDeliveryHeld('Ratchet delivery proof expired before relay handoff.');
  }
}

function parseFrame(data) {
  try {
    const frame = JSON.parse(typeof data === 'string' ? data : String(data));
    return Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

// One socket, one immutable event, one bounded attempt. There is no automatic
// reconnect or hidden retry. The caller must persist and retry the exact
// committed event, and must re-evaluate the current account fence each time.
export function publishRatchetEventAtProofBoundary({
  url,
  event,
  freshUntil,
  assertCurrent,
  createAuthEvent,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  timeoutMs = 5000,
  maxFrameBytes = 1024 * 1024,
}) {
  if (!url || !event?.id || !event?.sig || typeof WebSocketImpl !== 'function') {
    return Promise.reject(new Error('A relay URL, signed event, and WebSocket implementation are required.'));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    return Promise.reject(new Error('Invalid bounded relay attempt limits.'));
  }

  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let authSigning = false;
    let authEventId = null;
    let eventSent = false;
    const timer = setTimeout(() => finish(new Error('Ratchet relay attempt timed out.')), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close?.(); } catch { /* closing is best effort */ }
      if (error) reject(error);
      else resolve(result);
    };
    const guardedSend = (frame) => {
      if (settled) throw new RatchetDeliveryHeld('Ratchet relay attempt is already settled.');
      assertDeliveryCurrent({ freshUntil, now, assertCurrent });
      const encoded = JSON.stringify(frame);
      if (new TextEncoder().encode(encoded).byteLength > maxFrameBytes) {
        throw new RatchetDeliveryHeld('Ratchet relay frame exceeds the configured size limit.');
      }
      // Keep the proof/fence check adjacent to the synchronous socket handoff.
      assertDeliveryCurrent({ freshUntil, now, assertCurrent });
      socket.send(encoded);
    };
    const sendEvent = () => {
      guardedSend(['EVENT', event]);
      eventSent = true;
    };

    try {
      assertDeliveryCurrent({ freshUntil, now, assertCurrent });
      socket = new WebSocketImpl(url);
      socket.onopen = () => {
        try { sendEvent(); } catch (error) { finish(error); }
      };
      socket.onerror = () => finish(new Error('Ratchet relay WebSocket failed.'));
      socket.onclose = () => {
        if (!settled) finish(new Error('Ratchet relay WebSocket closed before acknowledgement.'));
      };
      socket.onmessage = async ({ data }) => {
        const frame = parseFrame(data);
        if (!frame) return;
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
          if (!eventSent || authSigning || typeof createAuthEvent !== 'function') return;
          authSigning = true;
          try {
            const authEvent = await createAuthEvent({ url, challenge: frame[1] });
  if (!authEvent?.id || !authEvent?.sig) throw new Error('AUTH signer returned an incomplete event.');
            authEventId = authEvent.id;
            guardedSend(['AUTH', authEvent]);
          } catch (error) {
            finish(error);
          }
          return;
        }
        if (frame[0] !== 'OK' || typeof frame[1] !== 'string') return;
        if (frame[1] === event.id) {
          if (frame[2] === true) finish(null, { accepted: true, eventId: event.id });
          else if (frame[2] === false) {
            const reason = String(frame[3] || 'rejected');
            // NIP-42 relays can first refuse EVENT and then provide AUTH. Keep
            // the bounded attempt alive until its challenge arrives (or the
            // timeout expires); the challenge may follow this acknowledgement.
            if (!reason.startsWith('auth-required')) {
              finish(new Error(`Ratchet relay refused event: ${reason}`));
            }
          }
          return;
        }
        if (authEventId && frame[1] === authEventId) {
          authSigning = false;
          if (frame[2] !== true) {
            finish(new Error(`Ratchet relay rejected AUTH: ${String(frame[3] || 'rejected')}`));
            return;
          }
          try { sendEvent(); } catch (error) { finish(error); }
        }
      };
    } catch (error) {
      finish(error);
    }
  });
}
