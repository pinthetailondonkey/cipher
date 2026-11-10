import { bindRelayRefresh, urlsFor } from './egress';
import { querySyncAfterAuth, querySyncAfterAuthDetailed } from './pool';
import { firstAnswer, noteAnswer, orderByHealth, patienceFor, readHealth, writeHealth } from './relayRace';

function fill(target, next) {
  target.splice(0, target.length, ...next);
}

export const generalRelays = [];
export const groupRelays = [];
export const groupOnlyRelays = [];
export const searchRelays = [];
export const profileRelays = [];
export const profileEditorRelays = [];
export const profileReadRelays = [];
export const usernameRelays = [];
export const productRelays = [];
// Trade proofs (vouches, reviews, riders, the proven bulletin) ride the
// group relays: see RELAY_SETS.reputation in egress.js.
export const reputationRelays = [];

export function refreshRelays() {
  fill(generalRelays, urlsFor('general'));
  fill(groupRelays, urlsFor('group'));
  fill(groupOnlyRelays, urlsFor('group-only'));
  fill(searchRelays, urlsFor('search'));
  fill(profileRelays, urlsFor('profile'));
  fill(profileEditorRelays, urlsFor('profileEditor'));
  fill(profileReadRelays, urlsFor('profileRead'));
  fill(usernameRelays, urlsFor('username'));
  fill(productRelays, urlsFor('product'));
  fill(reputationRelays, urlsFor('reputation'));
}

bindRelayRefresh(refreshRelays);
refreshRelays();

export const queryWithTimeout = (pool, relays, filter, timeoutMs = 4000) => {
  // querySyncAfterAuth asks again if the pool answered an AUTH challenge only
  // after the relay had already answered the first REQ with EOSE and left the
  // subscription alone. Without that second ask, every read of the group relay
  // came back empty however correctly it was signed.
  return Promise.race([
    querySyncAfterAuth(pool, relays, filter, timeoutMs).catch(() => []),
    new Promise(resolve => setTimeout(() => resolve([]), timeoutMs))
  ]);
};

// The same read, but a stage is done as soon as one relay has something to
// show instead of when its slowest member gives up. Each relay is asked on its
// own, in the order last time's answers earned it, and a relay that refused or
// stalled is given a short leash rather than the whole cap.
//
// An empty answer is never enough to finish a stage (see relayRace.js): the
// deletion list in particular must not be decided by whichever relay answered
// "nothing" first.
export const queryFirstAnswer = (pool, relays, filter, timeoutMs = 4000) => {
  const health = readHealth();
  const ordered = orderByHealth(relays, health);
  const attempts = ordered.map((url) => async () => {
    const patience = patienceFor(url, health, timeoutMs);
    const started = Date.now();
    let ok = true;
    let events = [];
    try {
      events = await querySyncAfterAuth(pool, [url], filter, patience);
    } catch {
      ok = false;
    }
    const found = Array.isArray(events) ? events : [];
    // Written straight away: the next stage is seconds from now, and a lost
    // hint only costs the next login its ordering.
    writeHealth(noteAnswer(readHealth(), url, { ms: Date.now() - started, ok, empty: found.length === 0 }));
    return found;
  });
  return firstAnswer(attempts, { timeoutMs });
};

export async function queryHistoryDetailed(pool, relays, filter, {
  limit = 500, maxLimit = 4000, maxRequests = 32, maxEvents = 10000,
  timeoutMs = 4000, maxDurationMs = 20000, signal,
} = {}) {
  const events = new Map();
  const started = Date.now();
  const urls = Array.from(new Set((relays || []).filter(Boolean)));
  const perRelay = {};
  let totalRequests = 0;
  for (const url of urls) {
    const gaps = [];
    let until = Number.isInteger(filter.until) ? filter.until : null;
    let pageLimit = Math.max(1, Math.min(limit, maxLimit));
    let requests = 0;
    let status = 'exhausted';
    while (requests < maxRequests && events.size < maxEvents && Date.now() - started < maxDurationMs) {
      if (signal?.aborted) { status = 'cancelled'; break; }
      const pageFilter = { ...filter, limit: pageLimit };
      if (until !== null) pageFilter.until = until;
      const budget = Math.max(1, Math.min(timeoutMs, maxDurationMs - (Date.now() - started)));
      let timer;
      const query = await Promise.race([
        querySyncAfterAuthDetailed(pool, [url], pageFilter, budget),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout', events: [] }), budget); }),
      ]);
      clearTimeout(timer);
      requests += 1;
      totalRequests += 1;
      if (query.status === 'error' || query.status === 'timeout') { status = query.status; break; }
      const page = query.events || [];
      if (!page.length) break;
      for (const event of page) if (event?.id) events.set(event.id, event);
      const oldest = Math.min(...page.map((event) => event.created_at).filter(Number.isFinite));
      if (!Number.isFinite(oldest) || oldest <= 0) { status = 'invalid-cursor'; break; }
      if (page.length >= pageLimit && pageLimit < maxLimit) { pageLimit = Math.min(maxLimit, pageLimit * 2); continue; }
      if (page.length >= pageLimit) {
        gaps.push({ since: oldest, until: oldest, reason: 'timestamp-boundary-at-limit' });
        if (until !== null && oldest >= until) { status = 'no-progress'; break; }
        until = oldest - 1;
        pageLimit = Math.max(1, Math.min(limit, maxLimit));
        continue;
      }
      if (until !== null && oldest >= until) { status = 'no-progress'; break; }
      until = oldest - 1;
      pageLimit = Math.max(1, Math.min(limit, maxLimit));
    }
    if (signal?.aborted) status = 'cancelled';
    else if (requests >= maxRequests) status = 'request-budget';
    else if (events.size >= maxEvents) status = 'event-budget';
    else if (Date.now() - started >= maxDurationMs) status = 'time-budget';
    perRelay[url] = { status, requests, gaps, coverage: 'server-claimed-exhaustion' };
    if (signal?.aborted || Date.now() - started >= maxDurationMs || events.size >= maxEvents) break;
  }
  const ordered = Array.from(events.values()).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const gaps = Object.entries(perRelay).flatMap(([relay, result]) => result.gaps.map((gap) => ({ relay, ...gap })));
  const complete = urls.length > 0 && urls.every((url) => perRelay[url]?.status === 'exhausted' && perRelay[url].gaps.length === 0);
  return {
    events: ordered,
    gaps,
    stopReason: signal?.aborted ? 'cancelled' : Date.now() - started >= maxDurationMs ? 'time-budget' : Object.values(perRelay).some((r) => r.status !== 'exhausted') ? 'partial' : 'exhausted',
    // NIP-01 EOSE means this relay ended this request; it cannot prove an
    // untrusted relay disclosed every match. Never label a single-relay scan
    // globally complete without an explicit reconciliation contract.
    complete,
    coverage: 'server-claimed-exhaustion',
    requests: totalRequests,
    perRelay,
  };
}

// Compatibility facade. Callers needing a completeness claim must migrate to
// queryHistoryDetailed; legacy consumers continue to receive an event array.
export async function queryAllPages(pool, relays, filter, options = {}) {
  return (await queryHistoryDetailed(pool, relays, filter, options)).events;
}

// Security records use the same responsive-first behavior for display while
// collecting every configured relay through the deadline for authoritative
// local processing. This is discovery only; callers still verify signatures,
// ownership and policy chains before applying records.
export async function querySecurityRecords(pool, relays, filter, timeoutMs = 4000, onUpdate = () => {}) {
  const urls = Array.from(new Set((relays || []).filter(Boolean)));
  const health = readHealth();
  const ordered = orderByHealth(urls, health);
  const byId = new Map();
  const outcomes = new Map();
  let firstDelivered = false;
  let timedOut = false;
  const tasks = ordered.map(async (url) => {
    const started = Date.now();
    try {
      const budget = patienceFor(url, health, timeoutMs);
      const query = await Promise.race([
        querySyncAfterAuthDetailed(pool, [url], filter, budget),
        new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout', events: [] }), budget)),
      ]);
      if (query.status === 'error' || query.status === 'timeout') {
        outcomes.set(url, { status: query.status, events: query.events?.length || 0, budgetMs: budget, error: query.error ? String(query.error?.message || query.error) : undefined });
        writeHealth(noteAnswer(readHealth(), url, { ms: Date.now() - started, ok: false }));
        return;
      }
      const events = query.events;
      const accepted = Array.isArray(events) ? events : [];
      outcomes.set(url, { status: query.status, events: accepted.length, budgetMs: budget, deadlineShortened: budget < timeoutMs });
      writeHealth(noteAnswer(readHealth(), url, { ms: Date.now() - started, ok: true, empty: accepted.length === 0 }));
      for (const event of accepted) if (event?.id) byId.set(event.id, event);
      if (!timedOut && accepted.length) {
        firstDelivered = true;
        onUpdate(Array.from(byId.values()));
      }
    } catch (error) {
      outcomes.set(url, { status: 'error', budgetMs: patienceFor(url, health, timeoutMs), error: String(error?.message || error) });
      writeHealth(noteAnswer(readHealth(), url, { ms: Date.now() - started, ok: false }));
    }
  });
  let timer;
  await Promise.race([Promise.all(tasks), new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
  clearTimeout(timer);
  if (!firstDelivered && byId.size) onUpdate(Array.from(byId.values()));
  const complete = !timedOut && ordered.every((url) => ['empty', 'events'].includes(outcomes.get(url)?.status) && !outcomes.get(url)?.deadlineShortened);
  return { events: Array.from(byId.values()), complete, timedOut, relays: ordered, outcomes: Object.fromEntries(outcomes) };
}
