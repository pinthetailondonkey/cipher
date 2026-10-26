import { getMyGroups, setMyGroups } from './myGroups';

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
    // metadata events; the creation record already on this device wins.
    : local.map((item, i) => (i === index ? { ...item, ...group, creator: item.creator || group.creator } : item)));
  return group;
}
