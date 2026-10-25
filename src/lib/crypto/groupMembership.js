import { groupRelayHttp } from '../egress';

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export const GROUP_RELAY_PUBKEY = '23163bd56d17f04cfb681c2d5389995e681f66be3dc0d8fb60122cdd152d3326';
export const NIP11_NEGATIVE_TTL_MS = 45_000;
export const MEMBER_REREAD_NEGATIVE_TTL_MS = 45_000;
export const MEMBER_OMISSION_TTL_MS = 8_000;

export const GROUP_TIMELINE_KINDS = [9, 9000, 9001, 9002, 9021, 9022, 39002];

let relayPubkeyCache = null;
const omissionCache = new Map();
const failureCache = new Map();

export function resetGroupRelayPubkeyCache() {
  relayPubkeyCache = null;
}

export function resetMemberRereadCache() {
  omissionCache.clear();
  failureCache.clear();
}

export function groupRelayPubkey(fetchImpl = globalThis.fetch, now = Date.now()) {
  if (relayPubkeyCache?.negative && now - relayPubkeyCache.at >= NIP11_NEGATIVE_TTL_MS) {
    relayPubkeyCache = null;
  }
  if (relayPubkeyCache?.promise && relayPubkeyCache.negative) return relayPubkeyCache.promise;
  if (relayPubkeyCache?.promise && !relayPubkeyCache.negative) return relayPubkeyCache.promise;

  const at = now;
  const attempt = Promise.resolve()
    .then(() => {
      const httpUrl = groupRelayHttp();
      if (!httpUrl) throw new Error('NIP-11 skipped');
      return fetchImpl(httpUrl, { headers: { Accept: 'application/nostr+json' } });
    })
    .then((response) => {
      if (!response?.ok) throw new Error('NIP-11 request failed');
      return response.json();
    })
    .then((info) => {
      const pubkey = String(info?.pubkey || '').toLowerCase();
      if (!HEX_PUBKEY.test(pubkey)) throw new Error('NIP-11 pubkey missing');
      relayPubkeyCache = { promise: Promise.resolve(pubkey), negative: false, at };
      return pubkey;
    })
    .catch(() => {
      const fallback = GROUP_RELAY_PUBKEY;
      if (relayPubkeyCache?.promise === attempt) {
        relayPubkeyCache = { promise: Promise.resolve(fallback), negative: true, at };
      }
      return fallback;
    });
  relayPubkeyCache = { promise: attempt, negative: false, at };
  return attempt;
}

export function groupRelayFilters(groupIds, since) {
  const ids = [...new Set((groupIds || []).filter((id) => typeof id === 'string' && id))];
  const filters = [];
  for (const id of ids) {
    const timeline = { kinds: GROUP_TIMELINE_KINDS, '#h': [id] };
    if (Number.isFinite(since)) timeline.since = since;
    filters.push(timeline);
    filters.push({ kinds: [39002], '#d': [id] });
  }
  return filters;
}

export function groupTimelinePlans(groupIds, since) {
  const ids = [...new Set((groupIds || []).filter((id) => typeof id === 'string' && id))];
  return ids.map((groupId) => ({
    groupId,
    filters: groupRelayFilters([groupId], since),
  }));
}

export function isRestrictedRelayClose(reason) {
  return /restricted/i.test(String(reason || ''));
}

export function groupRelayReq(subId, groupIds, since) {
  return ['REQ', subId, ...groupRelayFilters(groupIds, since)];
}

function pubkeyOf(member) {
  return typeof member === 'string' ? member : member?.pubkey || '';
}

export function isGroupAdmin(members, pubkey, creator) {
  if (!pubkey) return false;
  if (creator && pubkey === creator) return true;
  return (Array.isArray(members) ? members : []).some((member) => (
    pubkeyOf(member) === pubkey && member?.role === 'admin'
  ));
}

export function controlSubject(event) {
  if (!event) return '';
  if (event.kind === 9021 || event.kind === 9022) return event.pubkey || '';
  return event.tags?.find((tag) => tag[0] === 'p')?.[1] || event.pubkey || '';
}

export function authorizeGroupControl({ kind, sender, subject, members, creator }) {
  if (!sender) return false;
  if (kind === 39002) return false;
  if (kind === 9021 || kind === 9022) return sender === subject;
  if (kind === 9000 || kind === 9001 || kind === 9002) return isGroupAdmin(members, sender, creator);
  return false;
}

export function memberSnapshotGroupId(event) {
  const tags = event?.tags || [];
  return tags.find((tag) => tag[0] === 'd')?.[1] || tags.find((tag) => tag[0] === 'h')?.[1] || '';
}

export function authorizeMemberSnapshot({ event, relayPubkey = GROUP_RELAY_PUBKEY } = {}) {
  if (!event || event.kind !== 39002) return false;
  if (String(event.pubkey || '').toLowerCase() !== String(relayPubkey || '').toLowerCase()) return false;
  if (!memberSnapshotGroupId(event)) return false;
  const people = (event.tags || []).filter((tag) => tag[0] === 'p');
  return people.every((tag) => HEX_PUBKEY.test(String(tag[1] || '').toLowerCase()));
}

export function pickMemberSnapshot(events, relayPubkey, groupId) {
  const matches = (events || []).filter((event) => (
    authorizeMemberSnapshot({ event, relayPubkey }) && memberSnapshotGroupId(event) === groupId
  ));
  if (!matches.length) return null;
  const latest = matches.reduce((best, event) => (
    (event.created_at || 0) >= (best.created_at || 0) ? event : best
  ));
  return latest.tags
    .filter((tag) => tag[0] === 'p' && HEX_PUBKEY.test(String(tag[1] || '').toLowerCase()))
    .map((tag) => ({ pubkey: tag[1].toLowerCase(), role: tag[2] || 'member' }));
}

export async function refetchMembersCached({
  groupId,
  requester,
  now = Date.now(),
  refetch,
  ttl = MEMBER_OMISSION_TTL_MS,
} = {}) {
  const failed = failureCache.get(groupId);
  if (failed && now - failed.at < MEMBER_REREAD_NEGATIVE_TTL_MS) {
    return { queried: false, members: null };
  }
  const key = `${groupId}:${requester || ''}`;
  const cached = omissionCache.get(key);
  if (cached && now - cached.at < ttl) {
    return { queried: false, members: cached.members };
  }
  try {
    const members = await refetch();
    if (!Array.isArray(members)) {
      failureCache.set(groupId, { at: now });
      return { queried: true, members: null };
    }
    omissionCache.set(key, { at: now, members });
    failureCache.delete(groupId);
    return { queried: true, members };
  } catch {
    failureCache.set(groupId, { at: now });
    return { queried: true, members: null };
  }
}
