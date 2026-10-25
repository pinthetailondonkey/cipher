// The removal baseline cannot live only in IndexedDB. A reinstall wipes that,
// and the next membership list would be stored as if nobody had left.
// The owner publishes the member list to themselves as a replaceable kind
// 30078, NIP-44 sealed. A fresh install reads it back before deciding to rotate.
// This is not a chat message and it does not go through the outbox.

export const MEMBER_BASELINE_KIND = 30078;

let publisher = null;

export function memberBaselineTag(groupId) {
  return `cipher-members:${groupId}`;
}

export function memberList(members) {
  const out = [];
  const seen = new Set();
  for (const member of members || []) {
    const pubkey = typeof member === 'string' ? member : member?.pubkey || '';
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  out.sort();
  return out;
}

export function removedSinceBaseline(previous, current) {
  const now = new Set(memberList(current));
  return memberList(previous).filter((pubkey) => !now.has(pubkey));
}

export function memberBaselinePayload(groupId, members, at = Math.floor(Date.now() / 1000)) {
  return { v: 1, t: 'msnap', gid: groupId, members: memberList(members), at };
}

export function openMemberBaseline(payload) {
  if (!payload || payload.t !== 'msnap' || typeof payload.gid !== 'string' || !payload.gid) return null;
  return { groupId: payload.gid, members: memberList(payload.members), at: Number(payload.at) || 0 };
}

export function bindMemberBaselinePublisher(fn) {
  publisher = typeof fn === 'function' ? fn : null;
  return () => {
    if (publisher === fn) publisher = null;
  };
}

export function queueMemberBaseline(groupId, members) {
  if (!publisher || !groupId) return;
  Promise.resolve(publisher(groupId, memberList(members))).catch((error) => {
    console.warn('[group-key] Membership baseline was not published. A reinstall would miss the next removal:', error);
  });
}

export async function sealMemberBaseline({ senderPrivkey, senderPubkey, groupId, members, at }) {
  const { nip44, finalizeEvent } = await import('nostr-tools');
  const payload = memberBaselinePayload(groupId, members, at);
  const shared = nip44.v2.utils.getConversationKey(senderPrivkey, senderPubkey);
  const content = nip44.v2.encrypt(JSON.stringify(payload), shared);
  return finalizeEvent({
    kind: MEMBER_BASELINE_KIND,
    created_at: payload.at,
    tags: [['d', memberBaselineTag(groupId)]],
    content,
  }, senderPrivkey);
}

export async function decryptMemberBaselines(events, senderPrivkey, senderPubkey, groupId) {
  const { nip44 } = await import('nostr-tools');
  const shared = nip44.v2.utils.getConversationKey(senderPrivkey, senderPubkey);
  let best = null;
  for (const event of events || []) {
    const tag = event?.tags?.find((item) => item[0] === 'd')?.[1];
    if (tag !== memberBaselineTag(groupId)) continue;
    try {
      const opened = openMemberBaseline(JSON.parse(nip44.v2.decrypt(event.content, shared)));
      if (!opened || opened.groupId !== groupId) continue;
      const at = Number(event.created_at) || opened.at || 0;
      if (!best || at >= best.at) best = { ...opened, at };
    } catch {
      // A different device sealed with another key, or the event is junk.
    }
  }
  return best;
}
