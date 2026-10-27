// Chat-list time labels, Telegram's shorthand: now/Xm/Xh/Mon/Jan 5.
// Pure so tests can pass a fixed clock. Row timestamps arrive in Nostr
// seconds; anything already in milliseconds is accepted too.
function toMs(value) {
  const ts = Number(value) || 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

export function formatRelativeTime(ts, now = Date.now()) {
  const ms = toMs(ts);
  if (!ms) return '';
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) {
    return new Date(ms).toLocaleDateString('en-US', { weekday: 'short' });
  }
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
