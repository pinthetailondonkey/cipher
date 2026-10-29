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

  // `about: ''` rather than a missing tag: the relay and every reader treat
  // the two the same, and the tag list stays a fixed shape.
  const common = [['h', groupId], ['name', name], ['about', about || '']];

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

  return { create, meta, join };
}
