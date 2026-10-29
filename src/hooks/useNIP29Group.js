import { useCallback, useEffect } from 'react';
import { finalizeEvent, nip19 } from 'nostr-tools';
import { db, saveMessage, markChatRead } from '../db';
import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { groupRelays, generalRelays, groupOnlyRelays, queryWithTimeout } from '../lib/relays';
import { allowsTyping } from '../lib/privacy';
import { shortNpub } from '../lib/npub';
import { getMyGroups, setMyGroups } from '../lib/myGroups';
import { encodeGroupPayload, decodeGroupEvent } from '../lib/crypto/groupMessageCodec';
import { getAllGroupKeys, getCurrentGroupKey, putGroupKey } from '../lib/crypto/groupKeyStore';
import { authorizeGroupControl, authorizeGroupPin, authorizeMemberSnapshot, groupFrameAccepted, groupRelayPubkey, groupTimelinePlans, isRestrictedRelayClose, pickMemberSnapshot, pinnedMessageOf, trustedGroupCreator } from '../lib/crypto/groupMembership';
import { grantKeyRequest, loadMemberSnapshot, loadMemberSnapshotRecord, memberKey, patchMemberSnapshot, rememberMembers, rotateGroupEpoch } from '../lib/crypto/groupKeyRotation';
import { generateGroupKey } from '../lib/crypto/groupCipher';
import { heldGroupRow } from '../lib/groupJoin';
import { ACCESS_PRIVATE, ACCESS_PUBLIC, JOIN_APPROVAL, groupCreateTags, relayFacingLabel } from '../lib/groupCreate';
import { distributeGroupKey, epochsToBackfill } from '../lib/crypto/groupKeyDistribution';
import { publishWriteAhead, startOutboxSync } from '../lib/outbox';
import { groupSocketUrl } from '../lib/egress';
import { relaysForPeer } from '../lib/dmRelays';
import { dropSecuringSend, forgetPendingKeyRequest, queueSecuringSend, rememberPendingKeyRequest, resetKeyRequest, securingSendsFor } from '../lib/crypto/groupKeyRequest';
import { sortMessages, stampArrival } from '../features/chat/media';
import { admitRelayRoster, isJoinDenied, joinRequestDecision, denyPendingJoin, dropPendingJoin, clearJoinDenial, loadPendingJoins, queuePendingJoin, withoutDenied } from '../lib/groupJoinQueue.js';
import { allowsGroupJoins } from '../lib/privacy.js';
import { groupMetaAnnouncement } from '../lib/groupMetaAnnouncement.js';
import { clampGroupBody } from '../lib/disappearing';

// How long an authenticated group stream must have held before its close counts
// as a real drop rather than a refused handshake. A stream that authenticated
// and died inside this window was never working, so it must keep climbing the
// reconnect ladder like any other failure; only a stream that held earns the
// reset back to one second. Without this, a relay that authenticates and drops
// at once would reset the ladder on every flap — one loop traded for another.
const GROUP_LADDER_STABLE_MS = 10000;

function currentGroupRelay() {
  return groupSocketUrl() || '';
}

async function publishKeyDm(identity, dmEvent) {
  const peer = dmEvent.tags?.find((tag) => tag[0] === 'p')?.[1];
  const relays = peer ? await relaysForPeer(identity, peer) : generalRelays.slice();
  const pool = await getAuthenticatedPool(identity);
  const results = await Promise.allSettled(pool.publish(relays.length ? relays : generalRelays, dmEvent));
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('dm rejected');
}

async function fetchRelayMemberSnapshot(identity, groupId) {
  const relays = groupOnlyRelays.length ? groupOnlyRelays : groupRelays;
  if (!relays.length) throw new Error('No group relay');
  const pool = await getAuthenticatedPool(identity);
  const relayPubkey = await groupRelayPubkey();
  const [byDTag, byHTag] = await Promise.all([
    queryWithTimeout(pool, relays, { kinds: [39002], '#d': [groupId] }),
    queryWithTimeout(pool, relays, { kinds: [39002], '#h': [groupId] }),
  ]);
  const members = pickMemberSnapshot([...byDTag, ...byHTag], relayPubkey, groupId);
  if (!members) throw new Error('No membership snapshot');
  // H1 fix (round-three re-hack): this read feeds the gkey grant re-read and
  // the owner reconciler's distribution list — both must never see a denied
  // peer, whatever the open-join relay writes into its roster.
  return withoutDenied(groupId, members);
}

// Creator can no longer ride on the store record alone: the record is fed by
// forgeable channels (F3), so the claim needs standing before any control or
// grant decision takes a creator shortcut. Self-attested creation (this
// device made the group) or a non-member row in the relay-signed snapshot.
async function controlContext(groupId, identityPk) {
  const state = useChatStore.getState();
  const group = (state.groups || []).find((item) => item.id === groupId)
    || (state.activeGroup?.id === groupId ? state.activeGroup : null);
  const live = state.activeGroup?.id === groupId ? state.groupMembers : null;
  const members = Array.isArray(live) && live.length ? live : (group?.members || []);
  const record = await loadMemberSnapshotRecord(groupId).catch(() => null);
  const snapshot = Array.isArray(record?.members) && record.members.length ? record.members : members;
  return {
    creator: trustedGroupCreator({
      creator: group?.creator || '',
      identityPk,
      snapshot,
    }),
    members,
  };
}
const groupSessions = new Map();

// groupId -> created_at of the newest kind-9002 this session has applied.
// The group timeline sub replays metadata events on every resync (around
// sends), so the announcement decision needs a floor beyond the in-memory
// sys-<event-id> list, which the bootstrap refresh rebuilds away. Layered
// on the group record's persisted metaAt.
const appliedGroupMetaAt = new Map();

// Announcement state for a kind-9002 that changed something: the applied
// name/about and the created_at mark ride the group record and the scoped
// per-account group list, so the next replay of the same event compares
// equal and stays silent — across resyncs and across reloads.
function rememberAppliedGroupMeta(identityPk, groupId, updates, metaAt) {
  const payload = { ...updates, metaAt };
  useChatStore.getState().setGroups((prev) => (Array.isArray(prev) ? prev : []).map(
    (group) => (group.id === groupId ? { ...group, ...payload } : group),
  ));
  const localGroups = getMyGroups(identityPk);
  const idx = localGroups.findIndex((group) => group.id === groupId);
  if (idx !== -1) {
    localGroups[idx] = { ...localGroups[idx], ...payload };
    setMyGroups(identityPk, localGroups);
  }
  const active = useChatStore.getState().activeGroup;
  if (active?.id === groupId) useChatStore.getState().setActiveGroup({ ...active, ...payload });
}

// The device's own record for a group whose name it holds sealed, or null.
// Read from the persisted group list rather than the store row: the store row
// is rebuilt from the relay directory on every resync and the marker that says
// "this name did not come from the relay" has to outlive that.
function sealedGroupRecord(identityPk, groupId) {
  const local = getMyGroups(identityPk).find((group) => group?.id === groupId);
  if (!local) return null;
  return (local.labelSealed || local.access === ACCESS_PRIVATE) ? local : null;
}

// Who a sealed label may be sent to. The signed roster is the answer, minus
// anyone this device has denied — a name sent to an ex-member is a leak, not a
// delivery. A relay read that fails falls back to the roster this device
// already holds, because the alternative is a rename that reaches nobody.
async function labelRecipientsFor(identity, groupId) {
  try {
    const members = await fetchRelayMemberSnapshot(identity, groupId);
    const pubkeys = (members || []).map((member) => (typeof member === 'string' ? member : member?.pubkey)).filter(Boolean);
    if (pubkeys.length) return pubkeys;
  } catch {
    // The held roster below is the fallback.
  }
  const state = useChatStore.getState();
  const held = (state.activeGroup?.id === groupId ? state.groupMembers : null)
    || (state.groups || []).find((group) => group?.id === groupId)?.members
    || [];
  return held.map((member) => (typeof member === 'string' ? member : member?.pubkey)).filter(Boolean);
}

export function parseGroupReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return { id: '', relays: [], author: '' };
  if (/^naddr1/i.test(raw)) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded?.type === 'naddr') {
        return {
          id: String(decoded.data?.identifier || '').trim(),
          relays: Array.isArray(decoded.data?.relays) ? decoded.data.relays : [],
          author: decoded.data?.pubkey || '',
          kind: decoded.data?.kind,
        };
      }
    } catch (error) {
      console.warn('[NIP29] naddr could not be decoded, keeping the raw value:', error);
    }
  }
  return { id: raw, relays: [], author: '' };
}

// Group metadata off the relays, or null when the relays hold no metadata
// event at all for the address — the difference a deep link has to prove
// before it organizes a group row (drill residual: a forged address used
// to silent-join and name itself from the URL with no relay evidence).
function metadataFromEvent(latest) {
  const tag = (name) => latest.tags?.find((item) => item[0] === name)?.[1] || '';
  let content = {};
  try { content = JSON.parse(latest.content || '{}'); } catch { content = {}; }
  return {
    name: tag('name') || content.name || content.display_name || '',
    about: tag('about') || content.about || '',
    picture: tag('picture') || content.picture || '',
    // F3: the event author is not the creator — it is who signed the
    // newest metadata event. Nothing here draws a creator from forgeable
    // metadata. The author is surfaced so a name claim can be weighed
    // where it is adopted.
    creator: '',
    author: latest.pubkey || '',
  };
}

// The same lookup, saying which of three things happened. This read has
// always run on the account's own pool — the refusal was never about a
// missing identity; it was about the answer going into queryWithTimeout,
// whose `.catch(() => [])` turns "the relay would not admit this account"
// into "the relay holds nothing". A deep link named that verdict on screen,
// so a group its reader could not see was reported as a group that does not
// exist. The directory reader proves per relay that an answer ended, so it
// answers here too: 'found', 'absent' (a completed read with nothing in it)
// or 'unavailable' (the read never completed). The read is lent the account's
// own pool with closePool: false — the same object the signer was installed
// on, so the reader's re-issue can wait on this account's proof; the read
// simply never closes what it did not build.
export async function fetchGroupMetadataOutcome(identity, groupId, options = {}) {
  const reader = options.reader || await import('../lib/relayDirectoryRead');
  const pool = options.pool || await getAuthenticatedPool(identity);
  const read = (filter) => reader.readDirectory(groupRelays, filter, {
    timeoutMs: 4000, identity, createPool: () => pool, closePool: false,
  });
  const [metadata, legacy] = await Promise.all([
    read({ kinds: [39000], '#d': [groupId], limit: 10 }),
    read({ kinds: [9002], '#h': [groupId], limit: 10 }),
  ]);
  const latest = [...metadata.events, ...legacy.events].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  // One event off a relay that reached end-of-stored-events is evidence the
  // group exists, even when the other lookup never completed.
  if (latest) return { status: 'found', metadata: metadataFromEvent(latest), why: '' };
  if (metadata.status === reader.READ_OK && legacy.status === reader.READ_OK) {
    return { status: 'absent', metadata: null, why: '' };
  }
  return {
    status: 'unavailable',
    metadata: null,
    why: reader.whyUnavailable([...(metadata.answers || []), ...(legacy.answers || [])]),
  };
}

export async function fetchGroupMetadata(identity, groupId) {
  const outcome = await fetchGroupMetadataOutcome(identity, groupId);
  return outcome.metadata;
}

// The member roster, read as evidence rather than as a list to draw.
//
// Same reader, same lent pool, same per-relay proof as the metadata read
// above — a refusal and an empty answer stay distinguishable, which
// `queryWithTimeout` cannot do (it resolves [] for both and would make any
// proof built on it green forever). What comes back is the relay-signed
// snapshot only: `pickMemberSnapshot` drops a roster signed by anyone else,
// so a stranger cannot put this account in a group by publishing a 39002.
//
// Note the difference from `fetchGroupMembers`: that one adds the caller to
// the list when they are absent, which is right for drawing a member list and
// fatal as a proof. This one reports what the relay said, and nothing else.
export async function fetchMemberRosterOutcome(identity, groupId, options = {}) {
  const reader = options.reader || await import('../lib/relayDirectoryRead');
  const pool = options.pool || await getAuthenticatedPool(identity);
  const result = await reader.readDirectory(
    groupRelays,
    { kinds: [39002], '#d': [groupId], limit: 50 },
    { timeoutMs: 4000, identity, createPool: () => pool, closePool: false },
  );
  if (result.status !== reader.READ_OK) {
    return { status: 'unavailable', members: null, why: reader.whyUnavailable(result.answers) };
  }
  const relayPubkey = options.relayPubkey || await groupRelayPubkey();
  const members = pickMemberSnapshot(result.events, relayPubkey, groupId);
  if (!members) {
    // The read completed, but nothing in it was a roster this relay signed.
    return { status: 'unavailable', members: null, why: 'The relay did not send a member list that this account can check.' };
  }
  return { status: 'found', members, why: '' };
}

function sameOutgoingMessage(message, event, identity, clientId) {
  if (!message) return false;
  if (message.id === event.id) return true;
  if (clientId && (message.id === clientId || message.clientId === clientId)) return true;
  return !!(
    message.isSender
    && event.pubkey === identity?.pk
    && String(message.id || '').startsWith('temp-')
    && Math.abs((message.timestamp || 0) - (event.created_at || 0)) <= 8
  );
}

// The first arrival stamp wins: a relay echo of an optimistic send carries a
// later counter than the moment the message was made, and the made-here
// order is the truthful one.
function mergeGroupMessage(existing, incoming) {
  if (!existing) return incoming;
  const rawContent = incoming.rawContent || existing.rawContent || null;
  return {
    ...existing,
    ...incoming,
    arrival: existing.arrival ?? incoming.arrival,
    clientId: incoming.clientId || existing.clientId,
    rawContent,
    pending: !rawContent && !!incoming.pending,
    deliveryStatus: incoming.deliveryStatus || existing.deliveryStatus || 'sent',
  };
}

function withGroupTag(groupId, tags = []) {
  return [['h', groupId], ...tags.filter((tag) => tag[0] !== 'h')];
}

export async function loadGroupProfile(identity, rawId, passedName = null) {
  const parsed = parseGroupReference(rawId);
  const groupId = parsed.id;
  if (!groupId) throw new Error('Missing group id');
  let meta = {};
  try { meta = (await fetchGroupMetadata(identity, groupId)) || {}; }
  catch (error) { console.warn('[NIP29] Group metadata lookup failed:', error); }
  // A sealed group's relay metadata is the fixed placeholder, by design. The
  // device's own record holds the real words, and this read must not hand the
  // caller the placeholder to write over them — this is the "history fetch
  // re-saves the relay copy" path, and it is refused here at its source.
  const sealed = sealedGroupRecord(identity?.pk, groupId);
  const name = sealed
    ? (sealed.name || groupId.slice(0, 12))
    : (meta.name || (passedName && passedName !== 'Unnamed Group' ? passedName : '') || groupId.slice(0, 12));
  return {
    id: groupId,
    name,
    about: sealed ? (sealed.about || '') : (meta.about || ''),
    picture: meta.picture || '',
    isChannel: false,
    creator: meta.creator || parsed.author || '',
  };
}

function rejectAuthWaiters(session, error) {
  const pending = session.authWaiters.splice(0);
  pending.forEach((waiter) => waiter.reject(error));
}

function flushGroupSubs(session) {
  if (session.ws?.readyState !== WebSocket.OPEN) return;
  for (const [subId, filter] of session.subs) {
    session.ws.send(JSON.stringify(['REQ', subId, filter]));
  }
}

function markGroupAuthed(session) {
  session.authed = true;
  // When this stream authenticated. The ladder is reset on the close that ends
  // a stream which actually held, not here: a relay that authenticates and then
  // drops at once would otherwise reset the ladder on every flap and we would
  // have traded one loop for another.
  session.authedAt = Date.now();
  flushGroupSubs(session);
  const pending = session.authWaiters.splice(0);
  pending.forEach((waiter) => waiter.resolve());
}

function sendAuthResponse(session, challenge) {
  if (!challenge || !session.identity?.sk || session.authSent) return;
  const authEvent = finalizeEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', session.relayUrl || currentGroupRelay()],
      ['challenge', challenge],
    ],
    content: '',
  }, session.identity.sk);
  session.authEventId = authEvent.id;
  session.authSent = true;
  session.ws.send(JSON.stringify(['AUTH', authEvent]));
}

function handleGroupSocketFrame(session, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (error) {
    console.warn('[NIP29] Ignoring malformed group relay frame:', error);
    return;
  }
  if (!Array.isArray(msg)) {
    console.warn('[NIP29] Ignoring a group relay frame that is not an array.');
    return;
  }

  if (msg[0] === 'AUTH') {
    const challenge = typeof msg[1] === 'string' ? msg[1] : msg[1]?.challenge;
    try {
      sendAuthResponse(session, challenge);
    } catch (error) {
      console.error('[NIP29] Failed to authenticate group relay:', error);
      rejectAuthWaiters(session, error);
    }
    return;
  }

  if (msg[0] === 'OK') {
    const eventId = msg[1];
    const accepted = msg[2] === true;
    const reason = msg[3] || '';
    if (eventId && eventId === session.authEventId) {
      if (accepted) markGroupAuthed(session);
      else {
        session.authSent = false;
        console.error('[NIP29] Group relay rejected NIP-42 authentication:', reason);
        rejectAuthWaiters(session, new Error(reason || 'AUTH rejected'));
      }
      return;
    }
    const waiter = session.okWaiters.get(eventId);
    if (waiter) {
      session.okWaiters.delete(eventId);
      clearTimeout(waiter.timer);
      if (accepted) waiter.resolve(msg);
      else waiter.reject(new Error(reason || 'relay rejected event'));
    }
  }

  // Every EVENT frame is verified (id and signature) before any listener
  // sees it: a forged frame is dropped here, at the point of entry.
  if (!groupFrameAccepted(msg)) {
    console.warn('[NIP29] Dropped a group relay event with a bad id or signature:', msg?.[2]?.id);
    return;
  }

  for (const listener of session.listeners) {
    try { listener(msg); } catch (error) { console.error('[NIP29] Group frame listener failed:', error); }
  }
}

function connectGroupSocket(session) {
  if (session.closed) return;
  session.authed = false;
  session.authedAt = null;
  session.authSent = false;
  session.authEventId = null;
  const url = currentGroupRelay();
  if (!url) {
    console.warn('[group] The group relay is off.');
    useChatStore.getState().setToast({ type: 'error', message: 'The group relay is off.' });
    return;
  }
  session.relayUrl = url;
  const ws = new WebSocket(url);
  session.ws = ws;

  ws.onopen = () => {
    // Opening is not working. A relay that accepts the socket and then refuses
    // AUTH would otherwise reset the ladder on every attempt, so the backoff
    // never grew: one connection a second, for as long as the screen was open.
    // The ladder is reset by a stream that authenticated and then held, which
    // is the first evidence the connection actually works.
    console.log('✅ Group WS connected');
    window.dispatchEvent(new CustomEvent('cipher:relay-connected', { detail: { url } }));
  };

  ws.onmessage = (event) => handleGroupSocketFrame(session, event.data);

  ws.onerror = (event) => console.error('Group WS error:', event);

  ws.onclose = (event) => {
    console.log('❌ Group WS closed:', event.reason || event.code);
    const wasAuthed = session.authed;
    session.authed = false;
    session.authSent = false;
    rejectAuthWaiters(session, new Error('Group relay socket closed'));
    for (const [eventId, waiter] of session.okWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Group relay socket closed'));
      session.okWaiters.delete(eventId);
    }
    if (!session.closed) {
      // A stream that authenticated and then held earns a fresh ladder, so the
      // next outage starts from one second rather than from the cap. A stream
      // that authenticated and dropped straight away does not: the ladder keeps
      // climbing, exactly as it does for a relay that refuses AUTH.
      if (wasAuthed && session.authedAt && Date.now() - session.authedAt >= GROUP_LADDER_STABLE_MS) {
        session.attempt = 0;
      }
      session.authedAt = null;
      const attempt = session.attempt || 0;
      session.attempt = attempt + 1;
      const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt, 5)));
      session.reconnectTimer = setTimeout(() => connectGroupSocket(session), delay);
    }
  };
}

export function closeGroupSessions() {
  for (const session of groupSessions.values()) {
    session.closed = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    try { session.ws?.close(); } catch {}
    rejectAuthWaiters(session, new Error('Signed out'));
    for (const waiter of session.okWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Signed out'));
    }
    session.okWaiters.clear();
    session.listeners.clear();
    session.subs.clear();
  }
  groupSessions.clear();
}

function openGroupRelaySession(identity) {
  if (!identity?.pk || !identity?.sk) throw new Error('Group relay requires a signed-in key');
  const existing = groupSessions.get(identity.pk);
  if (existing && !existing.closed) {
    existing.identity = identity;
    return existing;
  }

  const session = {
    identity,
    ws: null,
    authed: false,
    authedAt: null,
    authSent: false,
    authEventId: null,
    closed: false,
    reconnectTimer: null,
    authWaiters: [],
    okWaiters: new Map(),
    subs: new Map(),
    listeners: new Set(),
  };
  groupSessions.set(identity.pk, session);
  connectGroupSocket(session);
  return session;
}

function whenGroupAuthed(session) {
  if (session.authed && session.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: () => { clearTimeout(waiter.timer); resolve(); },
      reject: (error) => { clearTimeout(waiter.timer); reject(error); },
    };
    waiter.timer = setTimeout(() => {
      const index = session.authWaiters.indexOf(waiter);
      if (index !== -1) session.authWaiters.splice(index, 1);
      reject(new Error('Group relay AUTH timed out'));
    }, 12000);
    session.authWaiters.push(waiter);
  });
}

async function publishAuthedGroupEvent(identity, event) {
  const session = openGroupRelaySession(identity);
  await whenGroupAuthed(session);
  if (!event.tags?.some((tag) => tag[0] === 'h' && tag[1])) {
    throw new Error('Group event is missing the h tag');
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.okWaiters.delete(event.id);
      reject(new Error('Group relay OK timed out'));
    }, 12000);
    session.okWaiters.set(event.id, { resolve, reject, timer });
    try {
      session.ws.send(JSON.stringify(['EVENT', event]));
    } catch (error) {
      clearTimeout(timer);
      session.okWaiters.delete(event.id);
      reject(error);
    }
  });
  return event;
}

const shouldSuppressGroup = (groupId) => {
  const state = useChatStore.getState();
  const mutedUntil = state.mutedUntil?.[groupId];
  const isMuted = mutedUntil === 'forever' || (mutedUntil && mutedUntil > Date.now());
  const isArchived = state.archivedChats?.includes(groupId);
  return isMuted || isArchived;
};

export async function flushSecuringGroupSends(identity, groupId) {
  if (!identity?.sk || !groupId) return;
  const items = securingSendsFor(identity.pk, groupId);
  for (const item of items) {
    const encoded = await encodeGroupPayload({ groupId: item.groupId, payload: item.payload, senderPubkey: identity.pk });
    if (encoded.pending) return;
    const tags = withGroupTag(item.groupId, encoded.tags);
    if (item.id) tags.push(['client', item.id]);
    if (item.replyId) tags.push(['e', item.replyId, '', 'reply']);
    const event = finalizeEvent({
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: encoded.content,
    }, identity.sk);
    try {
      await publishAuthedGroupEvent(identity, event);
      dropSecuringSend(identity.pk, item.id);
    } catch (error) {
      console.warn('[group-key] Waiting message did not go out:', error);
      return;
    }
  }
  if (items.length && (await getCurrentGroupKey(groupId)) && securingSendsFor(identity.pk, groupId).length === 0) {
    forgetPendingKeyRequest(identity.pk, groupId);
  }
}

export async function publishGroupJoin(identity, groupId) {
  if (!identity?.sk || !groupId) throw new Error('Unlock your account before joining.');
  const event = finalizeEvent({
    kind: 9021,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', groupId]],
    content: '',
  }, identity.sk);
  await publishAuthedGroupEvent(identity, event);
  return event;
}

export async function retrySecuringGroup(identity, groupId) {
  if (!identity?.sk || !groupId) throw new Error('Unlock your account first.');
  resetKeyRequest(identity.pk, groupId);
  const event = finalizeEvent({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', groupId]],
    content: JSON.stringify({ type: 'gkey_req' }),
  }, identity.sk);
  await publishAuthedGroupEvent(identity, event);
  await flushSecuringGroupSends(identity, groupId);
}

export function useNIP29Group({ identity }) {
  const setGroupsStore = useChatStore((s) => s.setGroups);
  const setGroups = useCallback((val) => {
    setGroupsStore((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      const myGroupIds = new Set(getMyGroups(identity?.pk).map(g => g.id));
      return (Array.isArray(next) ? next : []).filter(g => myGroupIds.has(g.id));
    });
  }, [identity?.pk, setGroupsStore]);
  const setGroupMessages = useChatStore((s) => s.setGroupMessages);
  const setGroupMembers = useChatStore((s) => s.setGroupMembers);
  const setGroupTypingUsers = useChatStore((s) => s.setGroupTypingUsers);
  const setPinnedMessages = useChatStore((s) => s.setPinnedMessages);
  const activeGroup = useChatStore((s) => s.activeGroup);

  useEffect(() => {
    if (!identity?.sk) return undefined;
    return startOutboxSync(identity);
  }, [identity?.pk, identity?.sk]);

  // A sealed label that arrived in a key bundle was written to the device's
  // own record by the crypto layer, which may not reach the store. This is the
  // hop that puts it on the open screen now instead of at the next resync.
  // It re-reads the persisted record, so what the screen shows and what a
  // reload shows cannot disagree.
  useEffect(() => {
    if (typeof window === 'undefined' || !identity?.pk) return undefined;
    const onLabel = (event) => {
      const groupId = event?.detail?.groupId;
      if (!groupId) return;
      const record = sealedGroupRecord(identity.pk, groupId);
      if (!record) return;
      rememberAppliedGroupMeta(identity.pk, groupId, {
        name: record.name,
        about: record.about || '',
        labelSealed: true,
      }, record.metaAt || 0);
    };
    window.addEventListener('cipher:group-label-updated', onLabel);
    return () => window.removeEventListener('cipher:group-label-updated', onLabel);
  }, [identity?.pk]);

  const appendSystemMessage = useCallback((groupId, text, eventId = null) => {
    const id = eventId ? 'sys-' + eventId : 'sys-' + Date.now() + Math.random().toString(36).substr(2, 9);
    setGroupMessages(prev => {
      const msgs = prev[groupId] || [];
      if (msgs.find(m => m.id === id)) return prev;
      return {
        ...prev,
        [groupId]: [
          ...msgs,
          stampArrival({
            id, isSender: false, isGroup: true, type: 'system',
            timestamp: Math.floor(Date.now() / 1000),
            rawContent: JSON.stringify({ type: 'system', message: text })
          })        ].sort(sortMessages)
      };
    });
  }, [setGroupMessages]);

  const createGroup = useCallback(async (name, about, isChannel, { access = ACCESS_PUBLIC, joinPolicy = JOIN_APPROVAL } = {}) => {
    const pool = await getAuthenticatedPool(identity);
    const groupId = (globalThis.crypto?.randomUUID?.() || Date.now().toString()).replace(/-/g, '').slice(0, 16);

    // The tags come from one pure builder so the wire shape is proved in a
    // test rather than in a screen. An unknown level throws there instead of
    // quietly creating a group more visible than the person asked for.
    const tags = groupCreateTags({ name, about, isChannel, access, joinPolicy, groupId, pubkey: identity.pk });
    const createdAt = Math.floor(Date.now() / 1000);

    const createEv = finalizeEvent({ kind: 9007, created_at: createdAt, tags: tags.create, content: '' }, identity.sk);

    const r9007 = await Promise.allSettled(pool.publish(groupRelays, createEv));
    const ok = r9007.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('No relay accepted 9007');

    const metaEv = finalizeEvent({ kind: 9002, created_at: createdAt, tags: tags.meta, content: '' }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, metaEv));

    // The join policy also goes out on its own 9002, through the update path
    // that has been seen working. Whether the relay honours the tag set on the
    // create event above is UNPROVEN, so the end state never depends on it.
    //
    // It carries the FULL metadata, not a bare ['join'] tag. A 9002 is a state
    // event: if this relay replaces the group's metadata with whatever the
    // newest one says, a bare join event would erase the name, the about and
    // the discovery tag. Sending the same tags again costs nothing and is safe
    // whether the relay adds to the state or replaces it.
    if (joinPolicy === JOIN_APPROVAL) {
      const policyEv = finalizeEvent({
        kind: 9002, created_at: createdAt + 1,
        tags: tags.meta,
        content: ''
      }, identity.sk);
      await Promise.allSettled(pool.publish(groupRelays, policyEv));
    }

    const joinEv = finalizeEvent({
      kind: 9021, created_at: createdAt,
      tags: tags.join, content: 'Creator'
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, joinEv));

    try {
      const existing = await getCurrentGroupKey(groupId);
      if (!existing) {
        const key = generateGroupKey();
        await putGroupKey(groupId, 1, key);
        await distributeGroupKey({
          senderPrivkey: identity.sk, senderPubkey: identity.pk,
          groupId, epoch: 1, keyBytes: key, recipients: [identity.pk],
          // The real name and description travel sealed, in the same envelope
          // as the key. On a public group `sealed` is null and this is the
          // bundle it has always been.
          label: tags.sealed,
          publish: (dmEvent) => publishKeyDm(identity, dmEvent),
        });
        await rememberMembers(groupId, [identity.pk]);
      }
    } catch (e) { console.warn('[createGroup] key bootstrap deferred', e); }

    appendSystemMessage(groupId, 'You created the group');
    // metaAt marks the bootstrap 9002 as the applied metadata: a replayed
    // older or equal metadata event must not announce a fake rename.
    // labelSealed marks a row whose name came from this device's own record
    // rather than from the relay's tags. On a private group the tags carry the
    // fixed placeholder, so every path that could refill the name from the
    // relay has to know not to.
    const newGroup = { id: groupId, name, about: about || '', isChannel, access, creator: identity.pk, members: [identity.pk], metaAt: metaEv.created_at, ...(tags.sealed ? { labelSealed: true } : {}) };

    const localGroups = getMyGroups(identity.pk);
    if (!localGroups.find(g => g.id === groupId)) {
      localGroups.push(newGroup);
      setMyGroups(identity.pk, localGroups);
    }
    setGroups(prev => [newGroup, ...(prev || []).filter(g => g.id !== groupId)]);

    return newGroup;
  }, [identity, setGroups, appendSystemMessage]);

  const joinGroupById = useCallback(async (groupId, passedName = null) => {
    const profile = await loadGroupProfile(identity, groupId, passedName);
    if (!profile.id) return;
    const newGroup = { ...profile };
    const localGroups = getMyGroups(identity.pk);
    const idx = localGroups.findIndex(g => g.id === newGroup.id);
    if (idx === -1) localGroups.push(newGroup);
    // A held row is named by this device's records, not by the metadata
    // the join/refresh arrived with (drill residual).
    else localGroups[idx] = heldGroupRow(localGroups[idx], newGroup);
    setMyGroups(identity.pk, localGroups);
    setGroups(prev => [
      heldGroupRow((prev || []).find((g) => g.id === newGroup.id), newGroup),
      ...((prev || []).filter((g) => g.id !== newGroup.id)),
    ]);
    const active = useChatStore.getState().activeGroup;
    if (active?.id === newGroup.id) useChatStore.getState().setActiveGroup(heldGroupRow(active, newGroup));
    return newGroup;
  }, [identity, setGroups]);

  const leaveGroup = useCallback(async (groupId) => {
    const pool = await getAuthenticatedPool(identity);
    const known = useChatStore.getState().groupMembers || [];
    const remaining = known.map((member) => member.pubkey).filter((pubkey) => pubkey && pubkey !== identity.pk);
    try {
      const rotation = await rotateGroupEpoch({
        identity,
        groupId,
        remainingPubkeys: remaining,
        publish: (dmEvent) => publishKeyDm(identity, dmEvent),
      });
      if (!rotation?.rotated) await rememberMembers(groupId, remaining);
    } catch (error) {
      console.error('[group-key] Could not rotate the key after a member left:', error);
      try { await rememberMembers(groupId, remaining); } catch (snapshotError) {
        console.error('[group-key] Could not update the membership snapshot:', snapshotError);
      }
    }
    const leaveEv = finalizeEvent({
      kind: 9022, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, leaveEv));
    appendSystemMessage(groupId, 'You left the group', leaveEv.id);

    const localGroups = getMyGroups(identity.pk);
    const updated = localGroups.filter(g => g.id !== groupId);
    setMyGroups(identity.pk, updated);
    setGroups(updated);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cipher:group-left', { detail: { groupId } }));
    }
  }, [identity, setGroups, appendSystemMessage]);

  const sendGroupMessage = useCallback(async (groupId, payload, clientId = null, replyId = null) => {
    try {
      const encoded = await encodeGroupPayload({ groupId, payload, senderPubkey: identity.pk, waitForKey: true });
      if (encoded.pending) {
        if (clientId) queueSecuringSend(identity.pk, { id: clientId, groupId, payload, replyId, since: Date.now() });
        // Drills D4: the keyless install floor opens on this record — it is
        // the evidence that this device itself asked for the key.
        rememberPendingKeyRequest(identity.pk, groupId);
        try {
          const reqEvent = finalizeEvent({
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: withGroupTag(groupId),
            content: JSON.stringify({ type: 'gkey_req' }),
          }, identity.sk);
          await publishAuthedGroupEvent(identity, reqEvent);
        } catch (error) {
          console.error('[NIP29] Failed to request a group key:', error);
        }
        return { success: false, error: 'NO_KEY' };
      }
      const tags = withGroupTag(groupId, encoded.tags);
      if (clientId) tags.push(['client', clientId]);
      if (replyId) tags.push(['e', replyId, '', 'reply']);
      const event = finalizeEvent({
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: encoded.content,
      }, identity.sk);
      // Write-ahead: the signed event is in the outbox before the relay is
      // tried and leaves it on the first accept (publishWriteAhead).
      const sent = await publishWriteAhead(event, null, () => [publishAuthedGroupEvent(identity, event)]);
      if (!sent.queued) return { success: true, event, relayCount: 1 };
      console.warn('[NIP29] Group relay did not accept the message after AUTH:', sent.results);
      return { success: true, queued: true, event, relayCount: 0 };
    } catch (error) {
      console.error('[NIP29] Failed to send group message:', error);
      return { success: false, error: error?.message || 'Group message failed' };
    }
  }, [identity]);

  const requestGroupKey = useCallback(async (groupId) => {
    // The floor reads this record before the request even clears the relay.
    rememberPendingKeyRequest(identity.pk, groupId);
    try {
      const ev = finalizeEvent({
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: withGroupTag(groupId),
        content: JSON.stringify({ type: 'gkey_req' }),
      }, identity.sk);
      await publishAuthedGroupEvent(identity, ev);
    } catch (error) {
      console.error('[group] Key request did not send:', error);
    }
  }, [identity]);

  const sendGroupTypingIndicator = useCallback(async (groupId) => {
    if (!allowsTyping()) return;
    try {
      const encoded = await encodeGroupPayload({ groupId, payload: { type: 'typing' }, senderPubkey: identity.pk });
      if (encoded.pending) return;
      const ev = finalizeEvent({
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: withGroupTag(groupId, encoded.tags),
        content: encoded.content,
      }, identity.sk);
      await publishAuthedGroupEvent(identity, ev);
    } catch (e) {}
  }, [identity]);

  const kickMember = useCallback(async (groupId, memberPubkey) => {
    // Drills D3-B: a kick is a durable removal, not a snapshot edit. The
    // rotation rotated, but the grant path read only the deny list — and
    // the kick never wrote one — so a replayed 9021 into an open-join
    // relay re-armed the kicked peer and shipped them the post-kick epoch.
    // The removal rides the same durable record the deny path uses.
    denyPendingJoin(groupId, memberPubkey);
    const pool = await getAuthenticatedPool(identity);
    const allMembers = useChatStore.getState().groupMembers || [];
    const remaining = allMembers.filter(m => m.pubkey !== memberPubkey).map(m => m.pubkey);
    if (!remaining.includes(identity.pk)) remaining.push(identity.pk);
    try {
      const rotation = await rotateGroupEpoch({
        identity,
        groupId,
        remainingPubkeys: remaining,
        publish: (dmEvent) => publishKeyDm(identity, dmEvent),
      });
      if (!rotation?.rotated) await rememberMembers(groupId, remaining);
    } catch (error) {
      console.error('[group-key] Could not rotate the key after a kick:', error);
      try { await rememberMembers(groupId, remaining); } catch (snapshotError) {
        console.error('[group-key] Could not update the membership snapshot:', snapshotError);
      }
    }
    const ev = finalizeEvent({
      kind: 9001, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.filter(m => m.pubkey !== memberPubkey));
    appendSystemMessage(groupId, `${shortNpub(memberPubkey)} was kicked from the group`, ev.id);
  }, [identity, setGroupMembers, appendSystemMessage]);

  const promoteMember = useCallback(async (groupId, memberPubkey, isAdmin) => {
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9000, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey], ['role', isAdmin ? 'member' : 'admin']],
      content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.map(m => m.pubkey === memberPubkey ? { ...m, role: isAdmin ? 'member' : 'admin' } : m));
    appendSystemMessage(groupId, `${shortNpub(memberPubkey)} was ${isAdmin ? 'demoted to member' : 'promoted to admin'}`, ev.id);
  }, [identity, setGroupMembers, appendSystemMessage]);

  const addMember = useCallback(async (groupId, memberPubkey) => {
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9000, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey]], content: ''
    }, identity.sk);
    // The publish outcome decides the row. If every relay rejected the add,
    // the owner must see the failure instead of a false success that drops
    // the request silently until a someday replay re-queues it.
    const results = await Promise.allSettled(pool.publish(groupRelays, ev));
    if (!results.some((result) => result.status === 'fulfilled')) {
      throw new Error('No relay accepted the add. Try again.');
    }
    // An owner-initiated add un-walls the member: a past kick or deny stops
    // blocking the grant path only through the owner's own act (drills
    // D1-E/D3-B) — a pending row for them stops it too.
    dropPendingJoin(groupId, memberPubkey);
    clearJoinDenial(groupId, memberPubkey);
    const snapshot = await loadMemberSnapshot(groupId);
    await rememberMembers(groupId, [...new Set([...(snapshot || []), memberPubkey, identity.pk])]);
    appendSystemMessage(groupId, `${shortNpub(memberPubkey)} was added to the group`, ev.id);
    setGroupMembers(prev => {
      if (prev.findIndex(x => x.pubkey === memberPubkey) === -1) {
        return [...prev, { pubkey: memberPubkey, role: 'member' }];
      }
      return prev;
    });
  }, [identity, setGroupMembers, appendSystemMessage]);

  const updateGroupSettings = useCallback(async (groupId, updates) => {
    const pool = await getAuthenticatedPool(identity);
    // A sealed group edits its name and description for its members, not for
    // the relay: the relay is re-sent the same fixed placeholder it already
    // holds, so a rename is byte-identical relay-side and reveals nothing by
    // diffing. The real words go to members through the sealed envelope.
    const sealedRecord = sealedGroupRecord(identity.pk, groupId);
    let relayUpdates = updates;
    if (sealedRecord && (updates.name || updates.about !== undefined)) {
      const relay = relayFacingLabel({
        name: updates.name || sealedRecord.name || '',
        about: updates.about !== undefined ? updates.about : (sealedRecord.about || ''),
        access: ACCESS_PRIVATE,
      });
      relayUpdates = {
        ...updates,
        ...(updates.name ? { name: relay.name } : {}),
        ...(updates.about !== undefined ? { about: relay.about } : {}),
      };
    }
    const tags = [['h', groupId]];
    if (relayUpdates.name) tags.push(['name', relayUpdates.name]);
    if (relayUpdates.about !== undefined) tags.push(['about', relayUpdates.about]);
    if (updates.avatar) tags.push(['picture', updates.avatar]);
    if (updates.requireApproval !== undefined) {
      tags.push(['join', updates.requireApproval ? 'approval' : 'open']);
    }
    const ev = finalizeEvent({
      kind: 9002,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    // The local edit is now the applied metadata: record the mark so a
    // replayed older 9002 can neither announce a fake change nor roll the
    // name back. (no group AAD touched — announcement dedup only)
    appliedGroupMetaAt.set(groupId, ev.created_at);
    rememberAppliedGroupMeta(identity.pk, groupId, updates, ev.created_at);
    // A sealed group's rename also goes to its members, sealed, on the same
    // ride a key rotation uses. The relay-side event above says nothing new;
    // this is where the new words actually travel.
    if (sealedRecord && (updates.name || updates.about !== undefined)) {
      const sealedName = updates.name || sealedRecord.name || '';
      const sealedAbout = updates.about !== undefined ? updates.about : (sealedRecord.about || '');
      rememberAppliedGroupMeta(identity.pk, groupId, { name: sealedName, about: sealedAbout, labelSealed: true }, ev.created_at);
      try {
        const current = await getCurrentGroupKey(groupId);
        const recipients = await labelRecipientsFor(identity, groupId);
        if (current && recipients.length) {
          await distributeGroupKey({
            senderPrivkey: identity.sk, senderPubkey: identity.pk,
            groupId, epoch: current.epoch, keyBytes: current.bytes,
            recipients,
            label: { name: sealedName, about: sealedAbout },
            publish: (dmEvent) => publishKeyDm(identity, dmEvent),
          });
        }
      } catch {
        // The id only. The name is the thing this fix keeps off the wire and
        // out of logs, so a failure may not carry it into either.
        console.warn('[group] A sealed group name could not be sent to every member.', { groupId });
      }
    }
    if (updates.name) appendSystemMessage(groupId, `Group name changed to "${updates.name}"`, ev.id);
    else if (updates.avatar) appendSystemMessage(groupId, 'Group photo was updated', ev.id);
    else if (updates.requireApproval !== undefined) appendSystemMessage(groupId, updates.requireApproval ? 'Joining this group now requires admin approval' : 'This group is now open to join', ev.id);
    else if (updates.about !== undefined) appendSystemMessage(groupId, 'Group description was updated', ev.id);
    return { success: true };
  }, [identity, appendSystemMessage]);

  const fetchGroupMembers = useCallback(async (groupId) => {
    try {
      const pool = await getAuthenticatedPool(identity);
      const [byDTag, byHTag] = await Promise.all([
        queryWithTimeout(pool, groupRelays, { kinds: [39002], '#d': [groupId] }),
        queryWithTimeout(pool, groupRelays, { kinds: [39002], '#h': [groupId] }),
      ]);
      // F2 fix (audit finding 2): the snapshot must be signed by the group
      // relay. Hand-parsing the newest event let any key impersonate the
      // member list — and that list is what key grants and admin checks
      // trust. Same gate the live subscription applies (authorizeMemberSnapshot).
      const relayPubkey = await groupRelayPubkey();
      // H1 fix (round-three re-hack): the stripped roster is the one the
      // member list, the owner reconciler and every grant read from — the
      // deny outvotes the relay wherever its snapshot names a denied peer.
      const members = withoutDenied(groupId, pickMemberSnapshot([...byDTag, ...byHTag], relayPubkey, groupId));
      if (!members) {
        console.warn(`[NIP29] No relay-signed membership snapshot found for group ${groupId}`);
        return null;
      }
      if (!members.some((member) => member.pubkey === identity.pk)) {
        members.push({ pubkey: identity.pk, role: activeGroup?.creator === identity.pk ? 'admin' : 'member' });
      }
      if (useChatStore.getState().activeGroup?.id === groupId) {
        setGroupMembers(members);
        // The list on screen is now one this device actually read. Until this
        // marker, the screen shows no count rather than a guess.
        useChatStore.getState().setGroupMembersKnown(groupId);
      }
      return members;
    } catch (err) {
      console.error('[useNIP29Group] fetchGroupMembers failed:', err);
      return null;
    }
  }, [identity?.pk, identity?.sk, activeGroup?.creator, setGroupMembers]);

  const subscribeToGroups = useCallback((groupIds, since) => {
    if (!groupIds || groupIds.length === 0 || !identity?.sk) return () => {};
    const session = openGroupRelaySession(identity);
    const plans = groupTimelinePlans(groupIds, since);
    const subIds = new Map();
    let notedRestricted = false;
    for (const plan of plans) {
      const subId = `group-sub-${plan.groupId.slice(0, 12)}-${Math.random().toString(36).slice(2, 8)}`;
      subIds.set(subId, plan.groupId);
      session.subs.set(subId, plan.filters);
      if (session.authed && session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify(['REQ', subId, ...plan.filters]));
      }
    }

    let keyHandler = null;

    const onFrame = async (msg) => {
      if (msg[0] === 'CLOSED' && subIds.has(msg[1])) {
        const closedGroup = subIds.get(msg[1]);
        const reason = String(msg[2] || '');
        console.warn(`[group] Relay closed ${closedGroup}: ${reason || 'no reason'}`);
        if (isRestrictedRelayClose(reason)) {
          session.subs.delete(msg[1]);
          if (!notedRestricted) {
            notedRestricted = true;
            useChatStore.getState().setToast({
              type: 'error',
              message: 'One group is unreachable. Your other groups are still live.',
            });
          }
        }
        return;
      }
      if (msg[0] !== 'EVENT' || !subIds.has(msg[1])) return;
      const event = msg[2];
      if (!event?.tags) return;
      const groupId = event.tags.find((tag) => tag[0] === 'h')?.[1] || event.tags.find((tag) => tag[0] === 'd')?.[1];
      if (!groupId || !groupIds.includes(groupId)) return;
      if (event.kind === 39002) {
        const relayPubkey = await groupRelayPubkey();
        if (!authorizeMemberSnapshot({ event, relayPubkey })) {
          console.warn('[group] Ignored a membership snapshot not signed by the group relay', event.id);
          return;
        }
        // An open-join relay names a denied sender in its snapshot; the local
        // deny outvotes the relay, so their row never lands or grants a key.
        const relayMembers = withoutDenied(groupId, pickMemberSnapshot([event], relayPubkey, groupId) || []);
        // On the owner's device a name the owner never approved is a join
        // request, not a member: it goes to the queue and stays off the
        // stored roster until the owner approves it.
        const owned = useChatStore.getState().groups.some((g) => g.id === groupId && g.creator === identity.pk);
        const { members, unapproved } = admitRelayRoster({
          previous: owned ? await loadMemberSnapshot(groupId) : null,
          incoming: relayMembers,
          isOwner: owned,
          selfPk: identity.pk,
        });
        for (const pk of unapproved) {
          if (!allowsGroupJoins()) { denyPendingJoin(groupId, pk); continue; }
          if (queuePendingJoin(groupId, { pubkey: pk, eventId: event.id, at: event.created_at })) {
            appendSystemMessage(groupId, `${shortNpub(pk)} wants to join. Approve it in Join requests.`, event.id);
          }
        }
        await rememberMembers(groupId, members);
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(members);
          useChatStore.getState().setGroupMembersKnown(groupId);
        }
        return;
      }
      if ([9000, 9001, 9002, 9021, 9022].includes(event.kind)) {
        const { creator, members } = await controlContext(groupId, identity.pk);
        const subject = event.kind === 9021 || event.kind === 9022
          ? event.pubkey
          : (event.tags.find((tag) => tag[0] === 'p')?.[1] || event.pubkey);
        if (!authorizeGroupControl({ kind: event.kind, sender: event.pubkey, subject, members, creator })) {
          console.warn('[group] Ignored an unauthorized membership event', event.kind, event.id);
          return;
        }
      }

      if (event.kind === 9021) {
        const pk = event.pubkey;
        const members = await loadMemberSnapshot(groupId);
        // One pure decision, in a fixed order (joinRequestDecision): a denied
        // or already-queued sender is stopped BEFORE the roster is looked at,
        // and presence in the stored roster is not approval — on the owner's
        // device a name the relay wrote that the owner never approved sits in
        // the queue (see admitRelayRoster), so it stops at 'ignore' here.
        const decision = joinRequestDecision({
          isSelf: pk === identity.pk,
          denied: isJoinDenied(groupId, pk),
          pending: Boolean(loadPendingJoins()[groupId]?.some((row) => row.pubkey === pk)),
          allowsJoins: allowsGroupJoins(),
          inSnapshot: Array.isArray(members) && members.some((member) => memberKey(member) === pk),
        });
        if (decision === 'ignore') {
          // Denied senders stay out even when this device's snapshot has been
          // widened by a relay, and a relay replay of a queued 9021 must not
          // re-queue the sender or fall through to the patch below — two
          // replayed joins were enough to sit on the member snapshot and pass
          // F1's sender-standing check. (F1 re-attack)
          return;
        }
        if (decision === 'deny') {
          // The Groups setting is Nobody: a first join request is refused,
          // and durably so — denyPendingJoin survives the relay's replays the
          // same way an owner deny does. (Joining is a trust edge: this is
          // where the setting finally has an engine.)
          denyPendingJoin(groupId, pk);
          return;
        }
        if (decision === 'queue') {
          // First join request from this sender: it goes to the pending queue
          // for owner approval instead of onto the snapshot. Nothing auto-adds
          // a stranger, so their key request reads a snapshot that does not
          // name them and is denied. The requester keeps seeing ciphertext, as
          // any keyless member does, until the owner approves them.
          const queued = queuePendingJoin(groupId, { pubkey: pk, eventId: event.id, at: event.created_at });
          if (queued) {
            const owned = useChatStore.getState().groups.some((g) => g.id === groupId && g.creator === identity.pk);
            if (owned) appendSystemMessage(groupId, `${shortNpub(pk)} wants to join. Approve it in Join requests.`, event.id);
            else console.log('[group] Join request queued for', groupId.slice(0, 6), 'from', pk.slice(0, 6));
          }
          return;
        }
        // 'self' (the creator's bootstrap join echo) and 'known' (a member of
        // record re-stating a join) fall through to the no-op patch below.
        await patchMemberSnapshot(groupId, (members) => (members.includes(pk) ? members : [...members, pk]));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => {
            const updated = Array.isArray(prev) ? [...prev] : [];
            if (updated.findIndex(m => m.pubkey === pk) === -1) updated.push({ pubkey: pk, role: 'member' });
            return updated;
          });
        }
        if (pk !== identity.pk) appendSystemMessage(groupId, `${shortNpub(pk)} joined the group`, event.id);
        return;
      }
      if (event.kind === 9022) {
        const pk = event.pubkey;
        await patchMemberSnapshot(groupId, (members) => members.filter((member) => member !== pk));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
        }
        appendSystemMessage(groupId, `${shortNpub(pk)} left the group`, event.id);
        return;
      }
      if (event.kind === 9000) {
        const pk = event.tags.find(t => t[0] === 'p')?.[1];
        const role = event.tags.find(t => t[0] === 'role')?.[1] || 'member';
        // The receiver arm of the kick wall: the add-back receipt an admin
        // addresses to THIS device is what clears its own removal record —
        // nothing else on this device un-walls it (drills D2 receiver arm).
        if (pk && String(pk) === String(identity.pk)) clearJoinDenial(groupId, identity.pk);
        if (pk) await patchMemberSnapshot(groupId, (members) => (members.includes(pk) ? members : [...members, pk]));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => {
            const updated = Array.isArray(prev) ? [...prev] : [];
            const idx = updated.findIndex(m => m.pubkey === pk);
            if (idx !== -1) updated[idx] = { ...updated[idx], role };
            else updated.push({ pubkey: pk, role });
            return updated;
          });
        }
        appendSystemMessage(groupId, `${shortNpub(pk)} was ${role === 'admin' ? 'promoted to admin' : 'demoted to member'}`, event.id);
        return;
      }
      if (event.kind === 9001) {
        const pk = event.tags.find(t => t[0] === 'p')?.[1];
        // The receiver arm of the kick wall (drills D2): when an authorized
        // admin's kick names THIS device, the removal becomes a durable
        // record on its own account. No member's key bundle in a DM re-arms
        // it afterwards; only this device's own add-back receipt (kind 9000)
        // clears the record. The kick is authorized above — a plain roster
        // row cannot write it.
        if (pk && String(pk) === String(identity.pk)) denyPendingJoin(groupId, identity.pk);
        if (pk) await patchMemberSnapshot(groupId, (members) => members.filter((member) => member !== pk));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
        }
        appendSystemMessage(groupId, `${shortNpub(pk)} was kicked from the group`, event.id);
        return;
      }
      if (event.kind === 9002) {
        // A sealed group's relay tags carry the fixed placeholder. Applying
        // them would announce a rename to "Private group" and write that over
        // the name this device holds, every time the timeline replays its
        // metadata. The tags say nothing about a sealed group that its own
        // members do not already know better, so they are ignored outright.
        if (sealedGroupRecord(identity.pk, groupId)) return;
        // A replayed 9002 is not a rename. The timeline sub re-delivers the
        // group's metadata around every send, and the bootstrap refresh
        // rebuilds groupMessages from the database (system messages are not
        // persisted), so the sys-<event-id> dedup alone cannot hold. The
        // announcement must compare the event against the metadata this
        // group already carries, and a genuine change must be applied so
        // the next replay stays silent.
        const state = useChatStore.getState();
        const stored = (state.groups || []).find((g) => g.id === groupId)
          || (state.activeGroup?.id === groupId ? state.activeGroup : null);
        const createdAt = event.created_at || 0;
        const appliedAt = Math.max(appliedGroupMetaAt.get(groupId) || 0, stored?.metaAt || 0);
        appliedGroupMetaAt.set(groupId, Math.max(appliedAt, createdAt));
        const decision = groupMetaAnnouncement({
          current: stored || {},
          name: event.tags.find(t => t[0] === 'name')?.[1] || '',
          about: event.tags.find(t => t[0] === 'about')?.[1] || '',
          createdAt,
          appliedAt,
        });
        if (decision) {
          appendSystemMessage(groupId, decision.text, event.id);
          const updates = {};
          if (decision.name) updates.name = decision.name;
          if (decision.about) updates.about = decision.about;
          rememberAppliedGroupMeta(identity.pk, groupId, updates, decision.appliedAt);
        }
        return;
      }
      // (H4, round-three re-hack: the dead second 39002 arm was deleted —
      // it remembered a roster with no relay-signature check. Unreachable
      // today, but one guard reorder away from a one-event roster forgery.)
      if (event.kind === 7) {
        const targetId = event.tags.find(t => t[0] === 'e')?.[1];
        if (targetId) {
          useChatStore.getState().setReactions(prev => {
            const existing = prev[targetId] || [];
            if (existing.find(r => r.pubkey === event.pubkey && r.emoji === event.content)) return prev;
            return { ...prev, [targetId]: [...existing, { emoji: event.content, pubkey: event.pubkey }] };
          });
        }
        return;
      }
      if (event.kind !== 9) return;

      const blocked = useChatStore.getState().blockedUsers || [];
      if (blocked.includes(event.pubkey) && event.pubkey !== identity.pk) return;

      let isGkeyReq = false;
      try {
        const parsedQuick = JSON.parse(event.content);
        if (parsedQuick.type === 'gkey_req') {
          isGkeyReq = true;
          if (event.pubkey !== identity.pk) {
            const record = await loadMemberSnapshotRecord(groupId);
            const current = await getCurrentGroupKey(groupId);
            const { creator } = await controlContext(groupId, identity.pk);
            const decision = await grantKeyRequest({
              groupId,
              requester: event.pubkey,
              creator,
              // F3: the device's own creation record is the one self-attested
              // standing; even a relay outage cannot take the owner's grant.
              selfCreated: useChatStore.getState().groups.some((it) => it.id === groupId && it.creator === identity.pk),
              snapshot: record?.members || null,
              updatedAt: record?.updatedAt,
              keyObtainedAt: current?.obtainedAt,
              fetchMembers: () => fetchRelayMemberSnapshot(identity, groupId),
            });
            if (decision === 'allow' && current) {
              const prior = epochsToBackfill(await getAllGroupKeys(groupId), current.epoch);
              await distributeGroupKey({
                senderPrivkey: identity.sk, senderPubkey: identity.pk,
                groupId, epoch: current.epoch, keyBytes: current.bytes,
                recipients: [event.pubkey],
                extraEpochs: prior,
                // An explicit request is answered whatever the ledger says
                // was sent before (rate limited inside distributeGroupKey).
                answerRequest: true,
                publish: (dmEvent) => publishKeyDm(identity, dmEvent),
              });
            }
          }
        }
      } catch (e) {
        // A silent catch here left a member on Securing forever with no
        // trace of why the request went unanswered.
        if (isGkeyReq) console.warn('[group-key] A key request was not answered:', e);
      }
      if (isGkeyReq) return;

      let parsed = {};
      let plaintext = event.content;
      let isPending = false;
      let decEpoch = null;
      const decoded = await decodeGroupEvent({ event, groupId });
      if (decoded.refused) {
        // Unencrypted content in a group that holds a key: dropped, never
        // shown as the sender's message.
        console.warn('[group] Dropped an unencrypted message in an encrypted group', event.id);
        return;
      }
      if (decoded.pending) { isPending = true; decEpoch = decoded.epoch; }
      else if (decoded.error) {
        console.warn('[group-decrypt] failed', decoded.reason);
        plaintext = typeof event.content === 'string' ? event.content : '';
        parsed = { type: 'text', message: plaintext || 'Message unavailable' };
      }
      else { plaintext = decoded.plaintext; parsed = decoded.parsed || {}; decEpoch = decoded.epoch; }
      if (!parsed || typeof parsed !== 'object') parsed = { type: 'text', message: typeof plaintext === 'string' ? plaintext : '' };

      // A stamp already dead carries no sentence — the arrival drop first.
      if (parsed.expires_at && Math.floor(Date.now() / 1000) >= parsed.expires_at) return;
      // Then the same rule the dm live arm holds: the receiver honors a
      // carried stamp only as far as the roster promised, and the stamped
      // JSON the row will save is rebuilt when the clamp moves it.
      ({ parsed, plaintext } = clampGroupBody(parsed, plaintext));

      if (!isPending && parsed.type === 'typing') {
        const age = (Date.now() / 1000) - event.created_at;
        if (age < 10 && event.pubkey !== identity.pk) {
          setGroupTypingUsers(prev => ({ ...prev, [event.pubkey]: Date.now() }));
        }
        return;
      }

      if (event.pubkey !== identity.pk) {
        setGroupMembers(prev => {
          if (prev.findIndex(m => m.pubkey === event.pubkey) === -1) {
            return [...prev, { pubkey: event.pubkey, role: 'member' }];
          }
          return prev;
        });
      }

      const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
      const clientId = event.tags.find(t => t[0] === 'client')?.[1];

      if (event.pubkey === identity.pk && clientId) {
        const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
        if (optimisticMessage?.chatId === groupId && optimisticMessage.isSender && optimisticMessage.id !== event.id) {
          await db.messages.delete(optimisticMessage.id);
        }
      }

      setGroupMessages(prev => {
        const groupMsgs = prev[groupId] || [];
        const existingIndex = groupMsgs.findIndex((m) => sameOutgoingMessage(m, event, identity, clientId));

        const baseMsg = stampArrival({
          id: event.id, clientId, isSender: event.pubkey === identity.pk,
          pubkey: event.pubkey, timestamp: event.created_at,
          deliveryStatus: event.pubkey === identity.pk ? 'sent' : undefined,
          local_timestamp: Date.now(),
          rawContent: isPending ? null : plaintext,
          ciphertext: isPending ? event.content : null,
          epoch: decEpoch, pending: isPending,
          replyTo: replyTag ? replyTag[1] : null, isGroup: true
        });

        if (existingIndex >= 0) {
          const newMsgs = [...groupMsgs];
          newMsgs[existingIndex] = mergeGroupMessage(newMsgs[existingIndex], baseMsg);
          saveMessage(groupId, newMsgs[existingIndex]);
          return { ...prev, [groupId]: newMsgs };
        }
        saveMessage(groupId, baseMsg);
        // A message arriving into the group on screen is read: the marker is
        // written to the database or the message counts as unread after reload.
        if (event.pubkey !== identity.pk && useChatStore.getState().activeGroup?.id === groupId) {
          markChatRead(groupId, Math.max(Math.floor(Date.now() / 1000), event.created_at));
        }
        if (event.pubkey !== identity.pk && !isPending && !shouldSuppressGroup(groupId)) {
          let isReplyToMe = false;
          let isMentioned = false;
          if (replyTag) {
            const msgs = useChatStore.getState().groupMessages[groupId] || [];
            const originalMsg = msgs.find(m => m.id === replyTag[1]);
            isReplyToMe = originalMsg && originalMsg.isSender;
          }
          try {
            const myProfile = useChatStore.getState().profiles[identity.pk];
            const myUsername = myProfile?.name || myProfile?.username;
            if (myUsername && parsed.message && parsed.message.includes('@' + myUsername)) isMentioned = true;
          } catch (e) {}
          // S11: the sender is the throttle key; only the OS notification is held back.
          if (isReplyToMe) showNotification(`💬 Reply in ${groupId.slice(0, 6)}`, event.pubkey);
          else if (isMentioned) showNotification('📣 You were mentioned', event.pubkey);
          else showNotification('New Group Message', event.pubkey);
        }
        return { ...prev, [groupId]: [...groupMsgs, baseMsg].sort(sortMessages) };
      });
    };

    session.listeners.add(onFrame);

    keyHandler = async (e) => {
      const { groupId: gid } = e.detail || {};
      if (!groupIds.includes(gid)) return;
      try {
        await flushSecuringGroupSends(identity, gid);
      } catch (error) {
        console.warn('[group-key] Could not send messages waiting on the key:', error);
      }
      try {
        const pool = await getAuthenticatedPool(identity);
        const events = await queryWithTimeout(pool, groupRelays, { kinds: [9], '#h': [gid], limit: 100 }, 4000);
        for (const event of events) {
          const decoded = await decodeGroupEvent({ event, groupId: gid });
          if (decoded.pending || decoded.error) continue;
          const parsed = decoded.parsed || {};
          if (parsed.type === 'typing') continue;
          // A row unwrapped now is a row arriving now: a stamp already
          // dead is not saved, and a carried stamp is honored only as far
          // as the roster promised — the same rule the live receive path
          // holds above.
          if (parsed.expires_at && Math.floor(Date.now() / 1000) >= parsed.expires_at) continue;
          const { plaintext: keptPlaintext } = clampGroupBody(parsed, decoded.plaintext);
          const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
          const clientId = event.tags.find(t => t[0] === 'client')?.[1];
          setGroupMessages(prev => {
            const groupMsgs = prev[gid] || [];
            const idx = groupMsgs.findIndex((m) => sameOutgoingMessage(m, event, identity, clientId));
            const newMsg = stampArrival({
              id: event.id, clientId, isSender: event.pubkey === identity.pk,
              pubkey: event.pubkey, timestamp: event.created_at,
              deliveryStatus: event.pubkey === identity.pk ? 'sent' : undefined,
              local_timestamp: Date.now(), rawContent: keptPlaintext,
              epoch: decoded.epoch, pending: false,
              replyTo: replyTag ? replyTag[1] : null, isGroup: true,
            });
            if (idx >= 0) {
              const updated = [...groupMsgs];
              updated[idx] = mergeGroupMessage(updated[idx], newMsg);
              saveMessage(gid, updated[idx]);
              return { ...prev, [gid]: updated };
            }
            saveMessage(gid, newMsg);
            return { ...prev, [gid]: [...groupMsgs, newMsg].sort(sortMessages) };
          });
        }
      } catch (err) { console.warn('[group-key] refresh failed', err); }
    };
    window.addEventListener('cipher:group-key-updated', keyHandler);

    return () => {
      session.listeners.delete(onFrame);
      for (const subId of subIds.keys()) {
        session.subs.delete(subId);
        if (session.ws?.readyState === WebSocket.OPEN) {
          try { session.ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* socket already gone */ }
        }
      }
      if (keyHandler) window.removeEventListener('cipher:group-key-updated', keyHandler);
    };
  }, [identity, setGroupMessages, setGroupTypingUsers, setGroupMembers, appendSystemMessage]);

  const pinMessage = useCallback(async (groupId, messageEventId) => {
    // S9: the pinned slot belongs to the group, so it moves only for a
    // creator or admin — the same standing the membership control kinds
    // demand. A member's pin goes nowhere and moves no one's slot.
    const standing = await controlContext(groupId, identity.pk);
    if (!authorizeGroupPin({ sender: identity.pk, members: standing.members, creator: standing.creator })) {
      throw new Error('Only the group owner or an admin can pin.');
    }
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9005,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['e', messageEventId]],
      content: ''
    }, identity.sk);
    const results = await Promise.allSettled(pool.publish(groupRelays, ev));
    if (!results.some((result) => result.status === 'fulfilled')) {
      throw new Error('All group relays rejected the pin.');
    }
    setPinnedMessages(prev => ({ ...prev, [groupId]: messageEventId }));
    return { success: true };
  }, [identity?.pk, identity?.sk, setPinnedMessages]);

  const unpinMessage = useCallback(async (groupId) => {
    // S9: unpinning moves the shared slot too, so it demands the same standing.
    const standing = await controlContext(groupId, identity.pk);
    if (!authorizeGroupPin({ sender: identity.pk, members: standing.members, creator: standing.creator })) {
      throw new Error('Only the group owner or an admin can unpin.');
    }
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9005,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId]],
      content: 'unpin'
    }, identity.sk);
    const results = await Promise.allSettled(pool.publish(groupRelays, ev));
    if (!results.some((result) => result.status === 'fulfilled')) {
      throw new Error('All group relays rejected the unpin.');
    }
    setPinnedMessages(prev => ({ ...prev, [groupId]: null }));
    return { success: true };
  }, [identity?.pk, identity?.sk, setPinnedMessages]);

  const fetchPinnedMessage = useCallback(async (groupId) => {
    try {
      const pool = await getAuthenticatedPool(identity);
      // Wide enough that a member flooding pins cannot push an admin's out
      // of the window: the standing check runs on everything, so a bigger
      // fetch only reads more events, never trusts more of them. (security S9)
      // A flood is still a shelf of its own width, so the owner's pin is
      // read in a filter of its own that a member cannot crowd: the owner's
      // pin wins the shared slot, and an admin's pin fills it only when the
      // owner has none. (security S9 re-attack)
      const standing = await controlContext(groupId, identity.pk);
      const read = (filter) => queryWithTimeout(pool, groupRelays, filter, 3000).catch(() => []);
      const [ownerEvents, memberEvents] = await Promise.all([
        standing.creator ? read({ kinds: [9005], '#h': [groupId], authors: [standing.creator], limit: 10 }) : [],
        read({ kinds: [9005], '#h': [groupId], limit: 500 }),
      ]);
      const pin = pinnedMessageOf(ownerEvents, memberEvents, (event) => (
        authorizeGroupPin({ sender: event.pubkey, members: standing.members, creator: standing.creator })
      ));
      setPinnedMessages(prev => ({ ...prev, [groupId]: pin }));
      return pin;
    } catch (e) {
      return null;
    }
  }, [identity?.pk, identity?.sk, setPinnedMessages]);

  return {
    createGroup,
    joinGroupById,
    addMember,
    leaveGroup,
    sendGroupMessage,
    sendGroupTypingIndicator,
    requestGroupKey,
    kickMember,
    promoteMember,
    fetchGroupMembers,
    updateGroupSettings,
    subscribeToGroups,
    pinMessage,
    unpinMessage,
    fetchPinnedMessage,
  };
}

