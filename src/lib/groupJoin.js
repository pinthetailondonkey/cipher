import { getMyGroups, setMyGroups } from './myGroups';

// Said when a join has gone out and the relay has not put this account in the
// group yet. One sentence, one place: the two join paths and the waiting
// screen all speak it, and none of them may promise a room.
export const PENDING_JOIN = "Request sent. Waiting on the owner's approval.";

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
    // A join that is still waiting on the owner is a fact this device holds.
    // A directory rebuild re-reads the relay's copy of the row; without this
    // line that copy would splat the state and the chat would open over the
    // refusals the waiting state exists to keep out.
    membership: local.membership || incoming.membership,
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

// The chat list's rebuild lays the relay's copy of a row over the device's
// own copy. The relay's words win there — that is how a group gets its name
// back after a reinstall — but two things are facts the relay never sent and
// cannot overwrite: who created the group on this device, and whether this
// account's join is still waiting. Without the second the pending state lives
// only until the next history fetch, which is the same as living in memory.
export function relayCopyOverRow(local, incoming) {
  return {
    ...local,
    ...incoming,
    creator: local.creator || incoming.creator,
    membership: local.membership || incoming.membership,
  };
}

// A sentence this file wrote. It is safe to show; a relay's reason is not.
function said(message) {
  return Object.assign(new Error(message), { said: true });
}

// The relay says it already counts this account. This is a TRIGGER, never a
// verdict: "duplicate: User is already a member" is one relay's wording, not
// a contract, and a relay that lies could otherwise force a chat open. So the
// words only decide that a membership read is worth doing. Narrow on purpose:
// the reason must name a membership and say it is already held, and a
// negation ("not a member") is never a membership.
export function duplicateClaimed(error) {
  const reason = String(error?.message || error || '').trim();
  if (!reason) return false;
  if (/\bnot\b/i.test(reason)) return false;
  if (/already\s+(?:a\s+)?member/i.test(reason)) return true;
  return /^duplicate:/i.test(reason) && /\bmember\b/i.test(reason);
}

// The verdict: this account's own pubkey in the group's member roster, as the
// relay signs it.
//
// A successful read is not evidence. Measured on the shipped relay
// (2026-10-29): a key that exists nowhere reads a `closed` group's messages
// straight through with no AUTH answered, so "the read worked" is true for
// everyone and a proof built on it would be green forever. The roster is
// different in kind: it is a list the relay signs, and the question is
// whether this pubkey is in it — not whether the relay refused to answer.
//
// So: found and mine -> member. Found and not mine -> pending. Not found
// (refused, timed out, or no relay-signed list) -> pending. Nothing else
// opens a chat, and `CLOSED auth-required` is only ever the reason it is
// pending, never a way in.
async function membershipConfirmed(identity, groupId, nip29, options) {
  const read = nip29?.fetchMemberRosterOutcome
    || (await import('../hooks/useNIP29Group')).fetchMemberRosterOutcome;
  if (typeof read !== 'function') return false;
  let outcome = null;
  try {
    outcome = await read(identity, groupId, options);
  } catch {
    return false;
  }
  if (outcome?.status !== 'found' || !Array.isArray(outcome.members)) return false;
  const me = String(identity?.pk || '').toLowerCase();
  return outcome.members.some((member) => String(member?.pubkey || '').toLowerCase() === me);
}

// A refusal becomes a sentence a person can act on. The relay's own reason
// never reaches the screen: it is machine text in lower case, and a group
// should not read like a log line.
export function joinRefusal(error) {
  if (error?.said) return error.message;
  const reason = String(error?.message || '');
  if (!reason) return 'Could not join that group.';
  if (/timed out|did not answer|socket closed|not answer/i.test(reason)) return 'The group relay did not answer. Try again in a moment.';
  if (/unlock|signed in|require/i.test(reason)) return 'Unlock your account, then try again.';
  if (/restricted|not allowed|denied|blocked|banned/i.test(reason)) return 'You are not allowed in that group.';
  return 'Could not join that group.';
}

// The one way into a group, from an invite link, search, or Discover. The
// relay sees the NIP-29 join (kind 9021) before the group is saved here, so
// nobody is left in a group the relay does not count them in, waiting for a
// key that will not be granted.
export async function joinGroup(identity, rawId, { name = null, channel = false, nip29, proofOptions } = {}) {
  const { parseGroupReference, loadGroupProfile, publishGroupJoin } = nip29 || await import('../hooks/useNIP29Group');
  const id = parseGroupReference(rawId).id;
  if (!id) throw said('That group address could not be read.');
  const profile = await loadGroupProfile(identity, id, name);
  const group = { ...profile, isChannel: !!(channel || profile.isChannel) };
  try {
    await publishGroupJoin(identity, group.id);
  } catch (error) {
    // The relay claims this account is already in the group. The claim buys
    // nothing on its own: it goes to the same proof every other join goes to,
    // and only the proof opens the door. Every other answer is a refusal.
    if (!duplicateClaimed(error)) throw error;
  }
  // One proof for both ways in. The request went out; whether this account is
  // inside is a separate question, and the relay's "OK" does not answer it.
  const confirmed = await membershipConfirmed(identity, group.id, nip29, proofOptions);
  const row = confirmed ? group : { ...group, membership: 'pending' };
  const local = getMyGroups(identity.pk);
  const index = local.findIndex((item) => item.id === group.id);
  setMyGroups(identity.pk, index === -1
    ? [...local, row]
    // F3: a re-join must not rewrite the creator with a claim that came off
    // metadata events; the creation record already on this device wins. The
    // same law for the words (drill residual): a held row keeps its name —
    // and for the membership state, the fresh proof decides it.
    : local.map((item, i) => (i === index ? { ...heldGroupRow(item, row), membership: row.membership } : item)));
  return row;
}
