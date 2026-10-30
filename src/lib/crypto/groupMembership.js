import { verifyEvent } from 'nostr-tools';
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

// The trust anchor for the signed member snapshot: the relay's own pubkey,
// read over NIP-11. Honest limits this stands on: the fetch is HTTPS
// attestation, not an event signature — a TLS-trusting transport is the
// anchor, a network attacker is not; a failed read falls back to the
// pinned constant and stays there for the negative TTL; a successful read
// stays cached for the session, so a relay rotating its key mid-session is
// picked up on the next reload, not on the next event. (round-three
// re-hack note H5/follow-up: documented limit, not a defect against the
// 39002 shape checks — the check refuses any event not signed by this key.)
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

// A group subscription the relay refused because this account is not in the
// group. The relay software words that refusal two ways and this must know
// both: `restricted:` (the older word) and `auth-required:` (NIP-01's own
// machine-readable prefix, used for the same decision on a private group).
// Matching only one of them leaves the other looking like a transient
// failure, so the dead subscription is kept and the toast never says why.
//
// Measured on the shipped relay (2026-10-29, read-only probe): a stranger's
// roster and timeline asks get an AUTH challenge and then EOSE — no CLOSED at
// all. So `auth-required` never arrives from that deployment today; it is the
// fallback shape for a relay that does enforce the refusal, and it is only
// ever a reason shown to the person, never a way into a group.
export function isRestrictedRelayClose(reason) {
  const text = String(reason || '');
  return /restricted/i.test(text) || /(?:^|\W)auth-required(?:\W|$)/i.test(text);
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

// F3 fix (audit finding 3): a creator name is a claim, and the channel it
// rode in on — the newest kind-39000/9002 metadata event, or an invite link —
// is forgeable. Group creation on this device is the one self-attested case;
// otherwise the claim needs standing in the relay-signed member snapshot: a
// row with a non-member role. Anything else returns '' and no decision
// downstream takes a creator shortcut.
export function trustedGroupCreator({ creator, identityPk = '', selfCreated = false, snapshot = null }) {
  const claimed = String(creator || '').toLowerCase();
  if (!claimed) return '';
  const me = String(identityPk || '').toLowerCase();
  if (selfCreated || (me && claimed === me)) return claimed;
  const row = (Array.isArray(snapshot) ? snapshot : []).find((member) => (
    String(pubkeyOf(member)).toLowerCase() === claimed
  ));
  if (row && typeof row === 'object' && row.role && row.role !== 'member') return claimed;
  return '';
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
  if (kind === 9000 || kind === 9001 || kind === 9002) {
    if (!isGroupAdmin(members, sender, creator)) return false;
    // H2 fix (round-three re-hack): a relay-asserted admin role is one
    // roster row the relay can write about anyone, and it used to be worth
    // full control — including kick and demote OF the owner. The creator
    // is the one name this device vets for standing, so control actions
    // AGAINST the creator require the creator's own key. A relay row
    // cannot dethrone the identity that created the group.
    if (subject && String(subject).toLowerCase() === String(creator || '').toLowerCase()
      && String(sender).toLowerCase() !== String(creator || '').toLowerCase()) {
      return false;
    }
    return true;
  }
  return false;
}

// S9 fix (audit finding 9): the shared pinned slot is a control surface, so
// the same standing that may kick or edit may pin — a creator or a relay-
// snapshot admin. A plain member's pin event is ignored: it never moves the
// slot for the group.
export function authorizeGroupPin({ sender, members, creator }) {
  return isGroupAdmin(members, sender, creator);
}

// The shared slot's pin: the owner's own pin wins, and an admin's pin fills
// the slot only when the owner has none. The owner's list is fetched in an
// authors filter of its own, so a member's pin flood can never crowd the
// owner's events out of the window a member list is read through.
// (security S9)
export function pinnedMessageOf(ownerEvents = [], memberEvents = [], authorize) {
  const pick = (events) => {
    const allowed = (events || []).filter((event) => authorize(event));
    if (allowed.length === 0) return null;
    allowed.sort((a, b) => b.created_at - a.created_at);
    return allowed[0].tags.find((t) => t[0] === 'e')?.[1] || null;
  };
  return pick(ownerEvents) ?? pick(memberEvents);
}

export function memberSnapshotGroupId(event) {
  const tags = event?.tags || [];
  return tags.find((tag) => tag[0] === 'd')?.[1] || tags.find((tag) => tag[0] === 'h')?.[1] || '';
}

// Audit finding: a socket frame's `pubkey` field is only a claim until the
// event id and signature check out. Without this, anyone who could put a
// frame on the group socket (a relay, or a hop that is not the relay) wrote
// a 39002 naming the relay's pubkey and it was believed. True only when the
// id is the hash of the event and the signature verifies against its pubkey.
export function eventSignatureValid(event) {
  if (!event || typeof event !== 'object') return false;
  try {
    // A plain copy of the seven wire fields: nostr-tools caches "verified" on
    // the object itself, and an object spread from a verified event carries
    // that mark along with edited tags. Only the wire fields are trusted.
    const { id, pubkey, created_at, kind, tags, content, sig } = event;
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig }) === true;
  } catch {
    return false;
  }
}

// The point of entry for the group socket: every EVENT frame is verified
// before any listener sees it. Frames that are not EVENT carry no signed
// event and pass through; an EVENT frame with a bad id or signature does not.
export function groupFrameAccepted(msg) {
  if (!Array.isArray(msg) || msg[0] !== 'EVENT') return true;
  return eventSignatureValid(msg[2]);
}

export function authorizeMemberSnapshot({ event, relayPubkey = GROUP_RELAY_PUBKEY } = {}) {
  if (!event || event.kind !== 39002) return false;
  if (!eventSignatureValid(event)) return false;
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
