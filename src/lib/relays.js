export const generalRelays = [
  'wss://relay.primal.net',
  'wss://groups.aegispayhq.com'
];

export const groupRelays = [
  'wss://groups.aegispayhq.com',
  'wss://relay.primal.net'
];

export const searchRelays = [
  'wss://relay.primal.net',
  'wss://relay.vertexlab.io',
  'wss://relay.noswhere.com'
];

export const queryWithTimeout = (pool, relays, filter, timeoutMs = 4000) => {
  return Promise.race([
    pool.querySync(relays, filter).catch(() => []),
    new Promise(resolve => setTimeout(() => resolve([]), timeoutMs))
  ]);
};

export async function queryAllPages(pool, relays, filter, { limit = 500, timeoutMs = 4000 } = {}) {
  const events = new Map();
  let until = Number.isInteger(filter.until) ? filter.until : null;
  let previousCursor = null;

  while (true) {
    const pageFilter = { ...filter, limit };
    if (until !== null) pageFilter.until = until;
    const page = await queryWithTimeout(pool, relays, pageFilter, timeoutMs);
    if (page.length === 0) break;

    for (const event of page) events.set(event.id, event);
    const oldest = Math.min(...page.map((event) => event.created_at).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || oldest <= 0) break;
    const nextCursor = oldest - 1;
    if (nextCursor === previousCursor || (until !== null && nextCursor >= until)) break;
    if (page.length < limit) break;
    previousCursor = nextCursor;
    until = nextCursor;
  }

  return Array.from(events.values());
}
