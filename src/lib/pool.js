import { groupSocketUrl } from './egress';

let pools = {};

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

// Which pool has answered an AUTH challenge for which relay host, and who is
// waiting to hear it. nostr-tools installs a signer from automaticallyAuth, but
// the library only re-issues a subscription when a relay closes one with
// "auth-required: " (abstract-pool.js:855). Our group relay answers an
// unauthenticated REQ with EOSE and never closes it, so a read that ran before
// the AUTH landed is final as far as the library is concerned: only the caller
// can ask again. The signer is the one moment we know the answer went out.
const poolAuth = new WeakMap();

function authState(pool) {
  let state = poolAuth.get(pool);
  if (!state) {
    state = { hosts: new Set(), waiters: new Set(), eligible: new Set() };
    poolAuth.set(pool, state);
  }
  return state;
}

// A host is eligible only where this pool installed a signer. Anywhere else a
// challenge can never arrive, so there is nothing to wait for.
function noteEligible(pool, host) {
  if (host) authState(pool).eligible.add(host);
}

function noteAuthed(pool, host) {
  if (!host) return;
  const state = authState(pool);
  state.hosts.add(host);
  for (const waiter of [...state.waiters]) {
    if (waiter.host !== host) continue;
    state.waiters.delete(waiter);
    waiter.resolve(true);
  }
}

function waitForHost(pool, host, timeoutMs) {
  if (!host) return Promise.resolve(false);
  const state = authState(pool);
  if (state.hosts.has(host)) return Promise.resolve(true);
  // The wait arms only on the relay this pool can answer. An empty read of a
  // public relay settles at its own speed instead of sitting out the deadline.
  if (!state.eligible.has(host)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter = { host, resolve: () => { clearTimeout(timer); resolve(true); } };
    const timer = setTimeout(() => { state.waiters.delete(waiter); resolve(false); }, timeoutMs);
    state.waiters.add(waiter);
  });
}

// Both halves of the contract above, installed on a pool the caller built —
// the account pool and a reader's own per-read pool alike. A pool built
// somewhere else has no eligibility of its own, so without this its re-issue
// resolves null for the group host as well: the wait half travelling without
// the half that arms it. The directory reader builds its own pool on purpose
// (it closes that pool at settle), so it needs this rather than the account's.
//
// `signFor(host, url)` returns the signing function for a host this pool may
// answer for, or null. Answering is the only thing that makes a host eligible.
// The note is deferred one macrotask for the measured reason above: signing
// returns before the library puts the signed frame on the socket.
export function installAutoAuth(pool, signFor) {
  if (!pool || typeof signFor !== 'function') return pool;
  pool.automaticallyAuth = (url) => {
    const host = hostOf(url);
    const sign = signFor(host, url);
    if (!sign) return null;
    // ensureRelay asks this before any read on the host goes out, so a wait
    // armed after the first empty answer always finds the host eligible.
    noteEligible(pool, host);
    return (authEvent) => {
      const signed = sign(authEvent);
      setTimeout(() => noteAuthed(pool, host), 0);
      return signed;
    };
  };
  return pool;
}

// Resolves true when this pool has authenticated against that relay, false if
// it had not within the window. Exported so a reader with its own loop (the
// directory reader) can hold its own subscription open and re-issue it here,
// rather than growing a second copy of this logic.
export const whenPoolAuthed = (pool, url, timeoutMs = 4000) => waitForHost(pool, hostOf(url), timeoutMs);

// Re-open a read on a relay the caller already holds, once this pool has
// answered that relay's challenge. The per-relay directory reader subscribes on
// relay.subscribe directly, because only that way can it prove end of stored
// events per relay; the library re-issues from inside the pool, so that caller
// cannot get the second ask any other way. Resolves with the subscription, or
// null when no challenge was answered and the first read stands.
export function reissueAfterAuth(pool, relay, filters, params, timeoutMs = 4000) {
  const host = hostOf(relay?.url || '');
  return waitForHost(pool, host, timeoutMs)
    .then((answered) => (answered ? relay.subscribe(filters, params) : null));
}

// The shared read: ask, and if nothing came back, wait for this pool to answer
// a challenge and ask once more. Both readers call this shape; neither keeps
// its own copy.
export async function querySyncAfterAuth(pool, relays, filter, timeoutMs = 4000) {
  const list = Array.isArray(relays) ? relays : [relays];
  const first = await pool.querySync(relays, filter).catch(() => []);
  if (first.length) return first;
  const results = await Promise.all(list.map((url) => waitForHost(pool, hostOf(url), timeoutMs)));
  if (!results.some(Boolean)) return first;
  const again = await pool.querySync(relays, filter).catch(() => []);
  return again.length ? again : first;
}

export const getAuthenticatedPool = async (identity) => {
  if (pools[identity.pk]) return pools[identity.pk];

  const { SimplePool, finalizeEvent } = await import('nostr-tools');
  const groupHost = hostOf(groupSocketUrl());
  const pool = new SimplePool({
    enablePing: false,
    enableReconnect: true,
    onRelayConnectionSuccess: (url) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cipher:relay-connected', { detail: { url } }));
      }
    },
  });
  // nostr-tools reads `automaticallyAuth`, not `onauth`: the constructor only
  // assigns opts.automaticallyAuth, and ensureRelay sets relay.onauth from it.
  // Under the old spelling this account never answered a challenge, so every
  // read of a relay with a member-scoped ACL went out unauthenticated.
  // It answers the group relay only: a clearnet relay that sends AUTH gets
  // nothing, so no public host can harvest a kind 22242 naming this account.
  // The factory marks that host eligible and defers the note; this is the same
  // install the directory reader puts on its own pool.
  installAutoAuth(pool, (host) => {
    if (!groupHost || host !== groupHost) return null;
    return (authEvent) => finalizeEvent(authEvent, identity.sk);
  });

  pools[identity.pk] = pool;
  return pool;
};

export const clearPool = () => {
  Object.values(pools).forEach((pool) => pool.destroy());
  pools = {};
};
