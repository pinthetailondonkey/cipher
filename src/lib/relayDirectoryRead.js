// A directory read that can say "I do not know".
//
// pool.querySync resolves with whatever it collected, and `[]` comes back both
// for a directory that really is empty and for a relay that refused the
// connection or never answered. The two are not the same claim. This reader
// asks each relay in turn and resolves only when it has a reason: a relay that
// reached end-of-stored-events for a request it did not first ask the account
// to prove itself for proves the read completed; a refused connection, a
// refusal, an answer given before the relay asked for proof, or a deadline
// proves it did not.

import { groupRelays, groupOnlyRelays } from './relays';
import { installAutoAuth, reissueAfterAuth } from './pool';

export const READ_OK = 'ok';
export const READ_UNAVAILABLE = 'unavailable';

// Answers per relay: 'eose' is the only one that proves completion.
const PROVEN = 'eose';
// The relay named itself as the reason it would not answer.
const REFUSED = 'auth';

// An account that can prove itself to a relay, or null when there is no
// secret key to sign with. The shape is nostr-tools' own: a kind-22242
// template comes in and a signed event goes back.
async function signerFor(identity) {
  if (!identity?.sk) return null;
  const { finalizeEvent } = await import('nostr-tools');
  return (authEvent) => finalizeEvent(authEvent, identity.sk);
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

// A proof names this account, so it is only ever given to the group host.
// A directory read can dial several relays; without this gate any of them
// could ask for a signed kind-22242 and learn who this person is. The same
// eligibility the group paths use: the group relay and the group-only relay.
export function isGroupHost(url) {
  const host = hostOf(url);
  if (!host) return false;
  return [...groupRelays, ...groupOnlyRelays].some((relay) => hostOf(relay) === host);
}

// The pool this reader builds. nostr-tools 2.25 answers an AUTH challenge
// through `automaticallyAuth`, which is called with the relay's own URL:
// returning null for a host we do not sign for leaves relay.onauth unset, so
// that relay gets no proof at all. A pool option spelled `onauth` is not read
// by that version, so it is not used here.
export async function defaultPool(identity) {
  const { SimplePool } = await import('nostr-tools');
  const pool = new SimplePool();
  const signer = await signerFor(identity);
  if (!signer) return pool;
  // `installAutoAuth` hands `signFor` the relay's host first and its own URL
  // second. `isGroupHost` takes a URL: given a bare host its internal
  // hostOf() gets '' and the group relay itself comes back false — a pool that
  // signs for nobody, with every "nothing leaked to a public relay" test still
  // green. The URL argument is the one used here for exactly that reason.
  installAutoAuth(pool, (_host, url) => (isGroupHost(url) ? signer : null));
  return pool;
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
    let sub = null;
    const seen = new Set();
    const settle = (status, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, status, reason });
    };
    const done = () => {
      settle(PROVEN, 'end of stored events');
      try { sub?.close('eose'); } catch { /* already closed */ }
    };
    const timer = setTimeout(() => {
      // A subscription that never reached EOSE proves nothing, even though it
      // may have handed us events on the way. Settle first: closing the
      // subscription fires onclose, and the deadline is the true reason.
      settle('timeout', 'no end of stored events before the deadline');
      try { sub?.close('directory read timed out'); } catch { /* already closed */ }
    }, Math.max(1, endsAt - Date.now()));
    // The challenge, if any, that was already on the table when this request
    // went out. A different one afterwards means the relay asked for a proof
    // *after* it had been asked for events.
    //
    // This test does not depend on a signer existing: abstract-pool.js stores
    // the challenge on the AUTH frame before it calls onauth, so a relay that
    // asks and a pool that cannot answer still look the same here. That is the
    // point — the read must stop claiming completion either way, whether the
    // account could prove itself or not.
    let challengeBefore = relay.challenge || null;
    const askedForProofSince = () => !!relay.challenge && relay.challenge !== challengeBefore;
    // End-of-stored-events from a relay that only asked this account to prove
    // itself once the request was already out is not proof the read completed:
    // it is the public half of it. Measured on the shipped relay (AUDITOR,
    // 2026-10-29, plain build): it answers the unproved request with EOSE
    // first, finishes the AUTH afterwards, and never re-sends the request —
    // so the rows behind the proof never arrive and the screen must not be
    // told the read completed. So the request is asked once more, through the
    // one shared helper in pool.js: it waits for this pool's own signer to
    // have answered, so the second ask goes out behind the proof, and it
    // resolves null when no proof came inside what is left of this read's
    // deadline. Null, or a second answer that is still unproved, is the
    // refusal sentence — never a hang, and never a loop.
    const settleUnproved = () => {
      settle(
        REFUSED,
        'auth-required: the relay asked this account to prove itself after the request had gone out',
      );
      try { sub?.close('auth-required'); } catch { /* already closed */ }
    };
    let askedAgain = false;
    const handlers = {
      onevent: (event) => {
        if (settled) return;
        if (event?.id) {
          if (seen.has(event.id)) return;
          seen.add(event.id);
        }
        events.push(event);
      },
      oneose: () => {
        if (settled) return;
        // An answer given to an account that had not been asked to prove
        // itself is the public half of the read, not the end of it.
        if (!askedForProofSince()) {
          // Otherwise this is the whole answer, and there is nothing left to
          // wait for: the deadline already bounds a relay that goes silent,
          // so no second timer is added here.
          return done();
        }
        if (askedAgain) return settleUnproved();
        askedAgain = true;
        // The challenge standing now was asked for the first request. The
        // second ask gets its own baseline, so an answer to it is judged on
        // whether the relay asked *again* after that one went out.
        challengeBefore = relay.challenge || null;
        return reissueAfterAuth(pool, relay, [filter], handlers, Math.max(1, endsAt - Date.now()))
          .then((second) => {
            if (settled) {
              try { second?.close('settled'); } catch { /* already closed */ }
              return undefined;
            }
            if (!second) return settleUnproved();
            // The first subscription already reached end of stored events, so
            // it is silent from here; it is left for pool.close() at settle
            // rather than closed here, because closing it would fire this same
            // onclose and be read as the read ending for another reason.
            sub = second;
            return undefined;
          })
          .catch(() => settleUnproved());
      },
      onclose: (reason) => {
        if (settled) return;
        const refused = String(reason || 'closed');
        settle(/auth/i.test(refused) ? REFUSED : 'closed', refused);
      },
    };
    try {
      sub = relay.subscribe([filter], handlers);
    } catch (error) {
      settle('closed', error?.message || 'could not subscribe');
    }
  });
}

// Resolves in every case, within timeoutMs. Never rejects: an unreadable
// directory is an answer, not an exception.
export async function readDirectory(relays, filter, {
  timeoutMs = 4000,
  identity = null,
  createPool = defaultPool,
  // A pool this read built is closed at settle. A pool it was lent — the
  // account's own — must not be: closing that would take the group relay's
  // connection down for every other reader in the app, and the next read
  // would simply reconnect and hide it. Both close paths are skipped, not
  // just the destroy.
  closePool = true,
} = {}) {
  const urls = [...new Set((relays || []).filter(Boolean))];
  if (urls.length === 0) return { status: READ_UNAVAILABLE, events: [], answers: [] };

  const endsAt = Date.now() + timeoutMs;
  const events = [];
  let pool;
  let answers = [];
  try {
    pool = await createPool(identity);
    answers = await Promise.all(urls.map((url) => readOneRelay(pool, url, filter, endsAt, events)));
  } catch (error) {
    answers = urls.map((url) => ({ url, status: 'closed', reason: error?.message || 'pool unavailable' }));
  } finally {
    if (closePool) {
      try { pool?.close(urls); } catch { /* nothing left to close */ }
      try { pool?.destroy?.(); } catch { /* nothing left to close */ }
    }
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
