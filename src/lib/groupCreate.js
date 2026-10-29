// The tags of the three events a group creation sends: the 9007 create, the
// 9002 metadata, and the creator's own 9021 join. Pure, so the wire shape can
// be proved without mounting a screen.
//
// Two levels, and they answer two different questions:
//   access      — who may READ.  public: anyone. private: members only.
//   joinPolicy  — who may WALK IN. approval: the owner decides.
//
// NIP-29 words them differently too: `private` withholds the shell, `closed`
// stops people walking in. A private group is both, because a private group
// anyone may walk into is not private.

export const ACCESS_PUBLIC = 'public';
export const ACCESS_PRIVATE = 'private';

export const JOIN_APPROVAL = 'approval';
export const JOIN_OPEN = 'open';

// The Private level is built, but its honest one-line description is a
// function of what the relay actually withholds, and that has one measurement
// behind it and two still owed (a member's read, and a join by link). Until
// they land, the screen may not offer a level whose consequence it cannot
// state, so the control says why it is not ready rather than guessing.
export const PRIVATE_LEVEL_READY = false;

const ACCESS_LEVELS = new Set([ACCESS_PUBLIC, ACCESS_PRIVATE]);
const JOIN_POLICIES = new Set([JOIN_APPROVAL, JOIN_OPEN]);

// What a private group's name and description read as on the wire.
//
// These are fixed strings, and that is the whole point. Anything derived from
// the real name — a hash, a truncation, a length — is comparable: a relay that
// sees two different placeholder values learns that two groups were renamed,
// and one that sees the same placeholder for two groups it already suspects
// learns nothing at all. A constant leaks neither the name nor the fact that a
// rename happened.
//
// The real name and description travel inside the sealed per-recipient key
// envelope instead (groupKeyDistribution). Public groups keep plaintext names:
// discovery reads them, and that is what a public group is for.
export const SEALED_LABEL = 'Private group';
export const SEALED_ABOUT = 'This group is sealed.';

export function relayFacingLabel({ name, about = '', access = ACCESS_PUBLIC }) {
  if (access !== ACCESS_PRIVATE) return { name, about: about || '' };
  return { name: SEALED_LABEL, about: SEALED_ABOUT };
}

// The fields a directory rebuild must take from the device's own record and
// never from the relay's row: the level the group was created at, and the mark
// that says its name came from here rather than from a tag. Kept as one
// function so the rebuild and the tests agree on exactly what survives.
export function heldSealedFields(local) {
  if (!local) return {};
  return {
    ...(local.access ? { access: local.access } : {}),
    ...(local.labelSealed ? { labelSealed: true } : {}),
  };
}

// An unknown value throws instead of falling back. A create that quietly
// defaulted would make a group more visible than the person asked for, which
// is the one failure this screen exists to prevent.
export function groupCreateTags({
  name,
  about = '',
  isChannel = false,
  access = ACCESS_PUBLIC,
  joinPolicy = JOIN_APPROVAL,
  groupId,
  pubkey,
} = {}) {
  if (!groupId) throw new Error('A group needs an id before it can be created.');
  if (!pubkey) throw new Error('A group needs a creator before it can be created.');
  if (!ACCESS_LEVELS.has(access)) throw new Error(`Unknown access level: ${access}`);
  if (!JOIN_POLICIES.has(joinPolicy)) throw new Error(`Unknown join policy: ${joinPolicy}`);

  // A private group's tags carry the fixed placeholder, never the real words.
  // The substitution happens here, in the one place that builds relay-facing
  // tags, so a caller cannot leak a name by passing it through.
  const relay = relayFacingLabel({ name, about, access });

  // `about: ''` rather than a missing tag: the relay and every reader treat
  // the two the same, and the tag list stays a fixed shape.
  const common = [['h', groupId], ['name', relay.name], ['about', relay.about]];

  const accessTags = access === ACCESS_PRIVATE
    ? [['private'], ['closed']]
    : [['open']];

  const create = [...common, ...accessTags, ['p', pubkey, 'admin']];

  const meta = [...common, ['join', joinPolicy]];
  // The discovery tag is a consequence of the level, not a setting. There is
  // no "public but unlisted" option: unticking "show in search" used to hide a
  // public group from this app's Discover and from nothing else, because the
  // relay still served it to any direct ask.
  if (access !== ACCESS_PRIVATE) meta.push(['cipher', 'true']);
  if (isChannel) {
    meta.push(['channel', 'true']);
    meta.push(['broadcast', 'true']);
  }

  const join = [['h', groupId]];

  // `sealed` is what the caller hands the key-distribution ride: the real name
  // and description, to be sealed to each member. Null on a public group,
  // whose name is public by design.
  const sealed = access === ACCESS_PRIVATE ? { name, about: about || '' } : null;

  return { create, meta, join, sealed };
}
