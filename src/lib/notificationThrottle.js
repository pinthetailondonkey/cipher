// The OS notification is the only thing the throttle slows down. A message
// still lands, is saved, and shows unread; only the buzz is held back when
// one sender — or a pile of senders — fires in a burst. (security S11)

// At most one notification per counterparty inside this window.
export const NOTIFICATION_PER_PEER_MS = 30_000;
// After any notification, a short quiet window for every counterparty.
export const NOTIFICATION_QUIET_MS = 2_000;

// Pure: the timing decision on its own, so the burst math tests without a
// browser or Capacitor in the room. `lastAny` and `lastPerPeer` are the
// times of notifications already shown; zero means none has fired yet.
export function notificationAllowed({
  peer = '',
  now = 0,
  lastPerPeer = {},
  lastAny = 0,
  perPeerMs = NOTIFICATION_PER_PEER_MS,
  quietMs = NOTIFICATION_QUIET_MS,
} = {}) {
  if (lastAny && now - lastAny < quietMs) return false;
  if (peer && lastPerPeer[peer] && now - lastPerPeer[peer] < perPeerMs) return false;
  return true;
}
