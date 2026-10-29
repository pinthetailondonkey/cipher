import { bindRelayRefresh, urlsFor } from './egress';
import { querySyncAfterAuth } from './pool';

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
