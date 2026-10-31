// The lifespan of a timed message, read from the one thing that travels
// with it: the sender's own expires_at stamp inside the payload. The chat's
// local timer (disappearingTimers) decides what a send stamps at compose;
// it is this device's setting, not a shared fact, so anything whose death
// depends on it alone resurrects the moment the setting is missing — a
// fresh device, a restored account, a relay-fetched copy re-saved over a
// swept row. (drill round residual)
//
// These helpers read the carried stamp wherever a row's own sooner clock
// speaks, so a row that died dies for good — on the load path and in the
// local sweep — whatever the local timer says.

const MAX_STAMP_SECONDS = 2592000; // 30 days — the roster's own longest timer

// The roster's choices as seconds, owned in the one place that speaks this
// vocabulary. Every site that stamps or sweeps reads this table — a private
// chain anywhere else is how a new option gets offered but never honored.
const TIMER_SECONDS = new Map([
  ['1h', 3600],
  ['24h', 86400],
  ['3d', 259200],
  ['7d', 604800],
  ['30d', 2592000],
]);

// A chat's timer setting as seconds: the roster's own choices, the legacy
// minute shape, and nothing else. Off, empty, a near-miss word and anything
// unknown all read as no timer at all — 0 — never a silent guess.
export function timerSeconds(value) {
  if (typeof value !== 'string' || !value) return 0;
  const fixed = TIMER_SECONDS.get(value);
  if (fixed != null) return fixed;
  if (value.endsWith('m')) {
    const minutes = parseInt(value, 10);
    return minutes > 0 ? minutes * 60 : 0;
  }
  return 0;
}

// The carried stamp on a stored row, or null. A DM carries it in `data`
// (the payload object); a group message carries it sealed away only as the
// rawContent JSON. Malformed JSON, a stamp that is not a positive number,
// and other shapes all read as no stamp: no stamp is not an expiry.
export function rowExpiresAt(row) {
  const stamp = Number(row?.data?.expires_at);
  if (Number.isInteger(stamp) && stamp > 0) return stamp;
  if (row?.rawContent) {
    try {
      const body = JSON.parse(row.rawContent);
      const raw = Number(body?.expires_at);
      if (Number.isInteger(raw) && raw > 0) return raw;
    } catch {
      return null;
    }
  }
  return null;
}

// A row past its carried stamp is dead — whole-seconds clock, "now" counts
// as dead, and a row with no stamp lives by whatever its chat's timer says
// (which is the sweeper's own business, not this answer).
export function rowExpired(row, now = Math.floor(Date.now() / 1000)) {
  const stamp = rowExpiresAt(row);
  return stamp != null && now >= stamp;
}

// The stamp a receiver is willing to honor, clamped before saving. A
// sender-written stamp absurdly far out (billions of seconds, past the
// roster's own longest choice) would promise a message that never dies —
// the timed-message contract is the roster's choices, so beyond the
// longest choice the stamp is honored as exactly that longest, and a
// non-integer or non-positive stamp carries no sentence to honor.
// Returns a clamped integer, or null when nothing honorable arrived.
export function clampedExpiresAt(value, now = Math.floor(Date.now() / 1000)) {
  const stamp = Number(value);
  if (!Number.isInteger(stamp) || stamp <= now) return null;
  return Math.min(stamp, now + MAX_STAMP_SECONDS);
}

// A decoded group message body ({ parsed, plaintext }) with its carried
// stamp clamped before the row is saved. When the clamp moves the stamp,
// the plaintext — the JSON the row will carry in rawContent — is rebuilt
// so the saved row and the kept body agree. Returns the body unchanged
// when it has no stamp to touch, and leaves both untouched when the
// plaintext does not round-trip as JSON.
export function clampGroupBody(parsed, plaintext, now = Math.floor(Date.now() / 1000)) {
  if (parsed?.expires_at == null) return { parsed, plaintext };
  const clampedStamp = clampedExpiresAt(parsed.expires_at, now);
  if (clampedStamp === parsed.expires_at) return { parsed, plaintext };
  const clamped = { ...parsed, expires_at: clampedStamp ?? undefined };
  if (typeof plaintext === 'string') {
    try {
      // The parsed body IS the plaintext content: rebuild the string from
      // the clamped body, not from the raw text (that would put the
      // unclamped stamp right back on the saved row).
      JSON.parse(plaintext);
      return { parsed: clamped, plaintext: JSON.stringify(clamped) };
    } catch { /* keep both untouched */ }
  }
  return { parsed, plaintext };
}
