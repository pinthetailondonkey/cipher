// A directory read that can say "I do not know".
//
// pool.querySync resolves with whatever it collected, and `[]` comes back both
// for a directory that really is empty and for a relay that refused the
// connection or never answered. The two are not the same claim. This reader
// asks each relay in turn and resolves only when it has a reason: a relay that
// reached end-of-stored-events proves the read completed; a refused
// connection, a refusal, or a deadline proves it did not.

export const READ_OK = 'ok';
export const READ_UNAVAILABLE = 'unavailable';

// Answers per relay: 'eose' is the only one that proves completion.
const PROVEN = 'eose';

async function defaultPool() {
  const { SimplePool } = await import('nostr-tools');
  return new SimplePool();
}

async function readOneRelay(pool, url, filter, endsAt, events) {
  const connectBy = Math.max(1, endsAt - Date.now());
  let relay;
  try {
    relay = await pool.ensureRelay(url, { connectionTimeout: connectBy });
  } catch (error) {
    return { url, status: 'unreachable', reason: error?.message || 'connection failed' };
  }
  return new Promise((resolve) => {
    let settled = false;
    let reachedEose = false;
    let sub = null;
    const settle = (status, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, status, reason });
    };
    const timer = setTimeout(() => {
      // A subscription that never reached EOSE proves nothing, even though it
      // may have handed us events on the way. Settle first: closing the
      // subscription fires onclose, and the deadline is the true reason.
      settle('timeout', 'no end of stored events before the deadline');
      try { sub?.close('directory read timed out'); } catch { /* already closed */ }
    }, Math.max(1, endsAt - Date.now()));
    try {
      sub = relay.subscribe([filter], {
        onevent: (event) => { if (!settled) events.push(event); },
        oneose: () => {
          reachedEose = true;
          // Close it here rather than waiting for the caller: the relay would
          // otherwise hold the subscription open after answering.
          try { sub?.close('eose'); } catch { /* already closed */ }
          settle(PROVEN, 'end of stored events');
        },
        onclose: (reason) => settle(reachedEose ? PROVEN : 'closed', reason || 'closed'),
      });
    } catch (error) {
      settle('closed', error?.message || 'could not subscribe');
    }
  });
}

// Resolves in every case, within timeoutMs. Never rejects: an unreadable
// directory is an answer, not an exception.
export async function readDirectory(relays, filter, { timeoutMs = 4000, createPool = defaultPool } = {}) {
  const urls = [...new Set((relays || []).filter(Boolean))];
  if (urls.length === 0) return { status: READ_UNAVAILABLE, events: [], answers: [] };

  const endsAt = Date.now() + timeoutMs;
  const events = [];
  let pool;
  let answers = [];
  try {
    pool = await createPool();
    answers = await Promise.all(urls.map((url) => readOneRelay(pool, url, filter, endsAt, events)));
  } catch (error) {
    answers = urls.map((url) => ({ url, status: 'closed', reason: error?.message || 'pool unavailable' }));
  } finally {
    try { pool?.close(urls); } catch { /* nothing left to close */ }
    try { pool?.destroy?.(); } catch { /* nothing left to close */ }
  }

  const proven = answers.some((answer) => answer.status === PROVEN);
  // Events that arrived from a relay whose read never completed are dropped:
  // this run cannot tell a partial list from a complete one.
  if (!proven) return { status: READ_UNAVAILABLE, events: [], answers };
  return { status: READ_OK, events, answers };
}

// Plain, short words for the screen. A reason is data, not a sentence.
export function whyUnavailable(answers) {
  if (!answers || answers.length === 0) return 'No relay is configured for this screen.';
  const reasons = answers.map((answer) => answer.reason).filter(Boolean);
  if (reasons.some((reason) => /auth/i.test(reason))) return 'The relay asked this account to prove itself and the read stopped there.';
  return 'The relay did not answer this screen.';
}
