// First good answer wins, per stage.
//
// Measured 2026-10-29: login waits twice, once for the group-metadata read and
// once for the DM history (useChatBootstrap.js) and a single stalling relay
// holds the whole stage to its 4 s cap even when seven relays answer at once.
// The stage waited for its SLOWEST member, which is the one thing a login must
// not do.
//
// The rule here: a stage is finished as soon as one relay has something to
// show. An EMPTY answer is never "good" — a relay with nothing says nothing
// about what the others hold, so emptiness only counts once every relay has
// answered (or the cap expires). That is what keeps a fast empty relay from
// hiding a slow relay's messages, and it is why the deletion list cannot lose
// a deletion behind a quicker empty reply.
//
// Health is remembered because the measurements say which failures are cheap:
// a refused socket fails at once, a stalling one costs the full cap. A relay
// that refused or stalled last time goes last next time and gets a short
// leash; one that answered keeps its place. Nothing here is sent anywhere —
// it is one localStorage entry on this device.

export const HEALTH_KEY = 'cipher_relay_health';
export const SLOW_MS = 2500;
export const REFUSED_COOLDOWN_MS = 10 * 60 * 1000;
export const SHORT_LEASH_MS = 800;

const RANK = { ok: 0, unknown: 1, slow: 2, bad: 3 };

export function readHealth(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(HEALTH_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeHealth(health, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(HEALTH_KEY, JSON.stringify(health));
  } catch {
    // A storage that refuses only costs the next login its hint.
  }
  return health;
}

export function gradeOf(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number') return 'unknown';
  if (entry.result === 'ok') return 'ok';
  if (entry.result === 'slow') return 'slow';
  if (entry.result === 'refused' || entry.result === 'silent') {
    return now - entry.at < REFUSED_COOLDOWN_MS ? 'bad' : 'unknown';
  }
  return 'unknown';
}

// Fast relays keep their order; the ones that made us wait go last. Stable, so
// the configured order still decides among equals.
export function orderByHealth(urls, health = {}, now = Date.now()) {
  const list = Array.isArray(urls) ? urls : [];
  return list
    .map((url, index) => ({ url, index, rank: RANK[gradeOf(health[url], now)] ?? RANK.unknown }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.url);
}

export function patienceFor(url, health = {}, fullMs = 4000, now = Date.now()) {
  const grade = gradeOf(health?.[url], now);
  if (grade === 'bad') return Math.min(SHORT_LEASH_MS, fullMs);
  if (grade === 'slow') return Math.min(SLOW_MS, fullMs);
  return fullMs;
}

export function noteAnswer(health, url, { ms, ok = true, empty = false }, now = Date.now()) {
  const next = { ...(health || {}) };
  if (!ok) next[url] = { result: 'refused', at: now };
  else if (!Number.isFinite(ms)) next[url] = { result: 'unknown', at: now };
  else if (ms >= SLOW_MS) next[url] = { result: 'slow', at: now, ms };
  else next[url] = { result: 'ok', at: now, ms, empty };
  return next;
}

const union = (lists) => {
  const byId = new Map();
  for (const list of lists) for (const event of list || []) if (event?.id) byId.set(event.id, event);
  return Array.from(byId.values());
};

// How long to keep collecting after the first relay answers. Zero would return
// whichever socket won the race even when two relays answer in the same tick,
// and a group list that silently drops the groups only the second relay knew
// is exactly the kind of saving that costs a person their data. A quarter of a
// second is invisible next to a 4 s cap and still short of the relays that
// made the login slow.
export const GRACE_MS = 250;

// attempts: one per relay, each a function returning a promise of an event
// array. Resolves once a relay has answered — plus a short grace so that
// relays answering together are merged — with everything that arrived by
// then; with [] only when every relay answered empty. It never rejects and
// never waits out a relay that has not answered.
export function firstAnswer(attempts, { timeoutMs = 4000, graceMs = GRACE_MS } = {}) {
  const list = (Array.isArray(attempts) ? attempts : []).filter((fn) => typeof fn === 'function');
  if (list.length === 0) return Promise.resolve([]);

  return new Promise((resolve) => {
    let settled = 0;
    let finished = false;
    const arrived = [];
    let capTimer = null;
    let graceTimer = null;

    const finish = (events) => {
      if (finished) return;
      finished = true;
      if (capTimer) clearTimeout(capTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(events);
    };

    capTimer = setTimeout(() => finish(union(arrived)), timeoutMs);

    for (const attempt of list) {
      Promise.resolve()
        .then(attempt)
        .then((events) => (Array.isArray(events) ? events : []))
        .catch(() => [])
        .then((events) => {
          settled += 1;
          if (events.length > 0) arrived.push(events);
          if (arrived.length === 0) {
            if (settled === list.length) finish([]);
            return;
          }
          // Everyone has either answered or given up by now: nothing left to
          // wait for, so the grace is not spent.
          if (settled === list.length) finish(union(arrived));
          else if (!graceTimer) graceTimer = setTimeout(() => finish(union(arrived)), graceMs);
        });
    }
  });
}
