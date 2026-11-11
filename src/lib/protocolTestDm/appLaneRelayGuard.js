// Loopback relay guard for the DM TEST app lane (TEST-ONLY).
//
// The publisher allowlist and every relay URL the lane touches must be a
// loopback WebSocket endpoint. This is the same shape rule
// lib/protocolTestMode.js enforces for the protocol-test artifact, applied to
// the integrated app lane: no public relay is ever addressed by this lane,
// regardless of what an account toggles or pastes.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function assertLoopbackRelayUrl(relayUrl) {
  let url;
  try { url = new URL(String(relayUrl || '')); } catch { throw new Error('The test-profile DM lane needs a valid WebSocket relay URL.'); }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('The test-profile DM lane speaks only WebSocket relays.');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`The test-profile DM lane addresses only loopback relays, not ${url.hostname}.`);
  }
  return `${url.protocol}//${url.host}`;
}
