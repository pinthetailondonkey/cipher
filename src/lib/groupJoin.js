import { getMyGroups, setMyGroups } from './myGroups';

// A row this device already holds keeps the words it holds. Every
// metadata event is signed by one author and the newest one can call the
// group anything — a refresh through a directory rebuild or a re-join
// must not splat that claim over a held row. A legitimate rename flows
// through the admin-authorized kind-9002 announcement path, which is the
// same standing the row's own writes always needed. (drill residual:
// forged metadata renamed a held row on the next fetch.)
export function heldGroupRow(local, incoming) {
  if (!local) return incoming;
  return {
    ...incoming,
    name: local.name || incoming.name,
    about: local.about || incoming.about,
    isChannel: local.isChannel != null ? local.isChannel : incoming.isChannel,
  };
}

// Bug #9 root cause (owner cannot approve): GroupView refreshed the open
// group with { ...current, ...profile }. loadGroupProfile has no creator to
// give (metadata never names one, on purpose), so it returns creator: '' and
// the spread erased the creator this device knew - the owner's own group
// lost its owner, and Join requests and Approve disappeared with it. A
// profile refresh now merges only the fields the profile actually carries,
// and a creator already known is never replaced or emptied by it.
//
// Returns { changed, next }; `changed` compares words with undefined and ''
// as the same thing (a new group has no picture field at all).
export function mergeGroupProfile(current, profile) {
  const held = current && typeof current === 'object' ? current : {};
  const incoming = profile && typeof profile === 'object' ? profile : {};
  const word = (value) => (typeof value === 'string' ? value : '');
  const next = { ...held };
  for (const field of ['name', 'about', 'picture']) {
    if (word(incoming[field])) next[field] = incoming[field];
  }
  if (!word(held.creator) && word(incoming.creator)) next.creator = incoming.creator;
  if (held.isChannel == null && incoming.isChannel != null) next.isChannel = incoming.isChannel;
  const changed = ['name', 'about', 'picture', 'creator'].some((field) => word(held[field]) !== word(next[field]))
    || (held.isChannel == null) !== (next.isChannel == null);
  return { changed, next };
}

// The one way into a group, from an invite link, search, or Discover. The
// relay sees the NIP-29 join (kind 9021) before the group is saved here, so
// nobody is left in a group the relay does not count them in, waiting for a
// key that will not be granted.
export async function joinGroup(identity, rawId, { name = null, channel = false, nip29 } = {}) {
  const { parseGroupReference, loadGroupProfile, publishGroupJoin } = nip29 || await import('../hooks/useNIP29Group');
  const id = parseGroupReference(rawId).id;
  if (!id) throw new Error('That group address could not be read.');
  const profile = await loadGroupProfile(identity, id, name);
  const group = { ...profile, isChannel: !!(channel || profile.isChannel) };
  await publishGroupJoin(identity, group.id);
  const local = getMyGroups(identity.pk);
  const index = local.findIndex((item) => item.id === group.id);
  setMyGroups(identity.pk, index === -1
    ? [...local, group]
    // F3: a re-join must not rewrite the creator with a claim that came off
    // metadata events; the creation record already on this device wins. The
    // same law for the words (drill residual): a held row keeps its name.
    : local.map((item, i) => (i === index ? heldGroupRow(item, { ...group, creator: item.creator || group.creator }) : item)));
  return group;
}
