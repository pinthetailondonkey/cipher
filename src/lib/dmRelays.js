import { dmTargets, parseRelayList, relayListTags } from './nip65';
import { getAuthenticatedPool } from './pool';
import { generalRelays, profileEditorRelays, profileReadRelays, queryWithTimeout } from './relays';

const inboxCache = new Map();
const published = new Set();
const INBOX_TTL_MS = 10 * 60 * 1000;

export async function relaysForPeer(identity, peer) {
  const ours = generalRelays.slice();
  const key = String(peer || '').toLowerCase();
  let theirs = [];
  const cached = inboxCache.get(key);
  if (cached && Date.now() - cached.at < INBOX_TTL_MS) {
    theirs = cached.read;
  } else {
    try {
      const pool = await getAuthenticatedPool(identity);
      const events = await queryWithTimeout(pool, profileReadRelays, { kinds: [10002], authors: [key], limit: 2 }, 2500);
      const newest = [...events].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
      theirs = parseRelayList(newest).read.filter(Boolean);
      inboxCache.set(key, { at: Date.now(), read: theirs });
    } catch (error) {
      console.warn('[DM] Relay list lookup failed:', error);
    }
  }
  const targets = dmTargets({ peer: key, ourWrite: ours, theirRead: theirs });
  return targets.length ? targets : ours;
}

export async function publishOwnRelayList(identity) {
  if (!identity?.sk || !identity?.pk || published.has(identity.pk)) return;
  if (!generalRelays.length || !profileEditorRelays.length) return;
  published.add(identity.pk);
  try {
    const { finalizeEvent } = await import('nostr-tools');
    const event = finalizeEvent({
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: relayListTags(generalRelays, generalRelays),
      content: '',
    }, identity.sk);
    const pool = await getAuthenticatedPool(identity);
    await Promise.allSettled(pool.publish(profileEditorRelays, event));
  } catch (error) {
    published.delete(identity.pk);
    console.warn('[DM] Could not publish the relay list:', error);
  }
}
