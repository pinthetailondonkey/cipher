import { useCallback, useEffect } from 'react';
import { nip19 } from 'nostr-tools';
import { db, saveMessage, markChatRead } from '../db';
import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool, setAuthProofGroup } from '../lib/pool';
import { groupRelays, generalRelays, groupOnlyRelays, queryWithTimeout } from '../lib/relays';
import { allowsTyping } from '../lib/privacy';
import { shortNpub } from '../lib/npub';
import { getMyGroups, setMyGroups } from '../lib/myGroups';
import { encodeGroupPayload, decodeGroupEvent } from '../lib/crypto/groupMessageCodec';
import { getCurrentGroupKey, putGroupKey } from '../lib/crypto/groupKeyStore';
import { authorizeGroupControl, authorizeGroupPin, authorizeMemberSnapshot, controlMembersFromDocument, groupFrameAccepted, groupRelayPubkey, groupTimelinePlans, isRestrictedRelayClose, mapRelayRosterToAccounts, pickMemberSnapshot, pinnedMessageOf, resolveControlSender, resolveKeyRequestRequester, trustedGroupCreator } from '../lib/crypto/groupMembership';
import { grantKeyRequest, isGroupRotationPending, loadMemberSnapshot, loadMemberSnapshotRecord, loadVerifiedMemberSnapshot, memberKey, patchMemberSnapshot, rememberMembers, publishMemberDocUpdate, rotateGroupEpoch } from '../lib/crypto/groupKeyRotation';
import { generateGroupKey } from '../lib/crypto/groupCipher';
import { generateDocKey, normalizeDocKey } from '../lib/crypto/groupDocKey';
import { getDocKey, putDocKey } from '../lib/crypto/groupKeyStore';
// Step 2 slice 3, live arm: onFrame routes kind 30079 by its constants and
// strips the doc d-tag prefix; both come from the publisher so neither can
// drift from the wire shape.
import { MEMBER_DOC_KIND, MEMBER_DOC_D_PREFIX } from '../lib/crypto/groupDocWire';
import { heldGroupRow } from '../lib/groupJoin';
import { ACCESS_PRIVATE, ACCESS_PUBLIC, JOIN_APPROVAL, groupCreateTags, relayFacingLabel } from '../lib/groupCreate';
import { distributeGroupKey } from '../lib/crypto/groupKeyDistribution';
import { publishWriteAhead, startOutboxSync } from '../lib/outbox';
import { groupSocketUrl } from '../lib/egress';
import { relaysForPeer } from '../lib/dmRelays';
import { dropSecuringSend, forgetPendingKeyRequest, queueSecuringSend, rememberPendingKeyRequest, resetKeyRequest, securingSendsFor } from '../lib/crypto/groupKeyRequest';
import { sortMessages, stampArrival } from '../features/chat/media';
import { admitRelayRoster, isJoinDenied, joinRequestDecision, denyPendingJoin, dropPendingJoin, clearJoinDenial, loadPendingJoins, queuePendingJoin, withoutDenied } from '../lib/groupJoinQueue.js';
import { allowsGroupJoins } from '../lib/privacy.js';
import { groupMetaAnnouncement } from '../lib/groupMetaAnnouncement.js';
import { clampGroupBody } from '../lib/disappearing';
import { buildSignedAct, buildControlAct, resolveActorSigner, signActProof } from '../lib/crypto/gmIdentityWire';
import { socketProofGroupId } from '../lib/groupSocketProof';
import { buildAdmissionRequest, openAdmissionRequest } from '../lib/crypto/groupAdmission.js';
import { pendingJoinsFor } from '../lib/groupJoinQueue.js';
import { readAuthorityPin } from '../lib/crypto/authorityPins.js';
import { actorPinOfRow } from '../lib/crypto/groupDoc.js';
import { queueMemberBaseline } from '../lib/crypto/memberBaseline.js';

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
  const standing = await loadMemberSnapshot(groupId).catch(() => null);
  return withoutDenied(groupId, mapRelayRosterToAccounts(members, standing));
}

// Creator can no longer ride on the store record alone: the record is fed by
// forgeable channels (F3), so the claim needs standing before any control or
// grant decision takes a creator shortcut. Self-attested creation (this
// device made the group) or a non-member row in the relay-signed snapshot.
async function controlContext(groupId, identityPk) {
  const state = useChatStore.getState();
  const group = (state.groups || []).find((item) => item.id === groupId)
    || (state.activeGroup?.id === groupId ? state.activeGroup : null);
  // Never authorize wire controls against local/UI roster state. Old versions
  // could populate that state from the shared-key `by` attribution hint.
  const documentMembers = await loadVerifiedMemberSnapshot(groupId).catch(() => null);
  const members = controlMembersFromDocument(documentMembers);
  return {
    creator: trustedGroupCreator({
      creator: group?.creator || '',
      identityPk,
      snapshot: members,
    }),
    members,
  };
}

async function actorPinForMember(identity, groupId, accountPubkey) {
  const account = String(accountPubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) return '';
  if (account === String(identity?.pk || '').toLowerCase()) {
    return (await resolveActorSigner({ identity, groupId }))?.pin || '';
  }
  const rows = await loadVerifiedMemberSnapshot(groupId);
  const row = (rows || []).find((item) => String(typeof item === 'string' ? item : item?.pubkey || '').toLowerCase() === account);
  return actorPinOfRow(row);
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
  setAuthProofGroup(pool, groupId);
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

function sameOutgoingMessage(message, event, identity, clientId, byPubkey = null) {
  if (!message) return false;
  if (message.id === event.id) return true;
  if (clientId && (message.id === clientId || message.clientId === clientId)) return true;
  // Step 2: the wire pubkey is the actor pin; the account-level answer lives
  // in the sealed body's by field, which the caller resolves and passes.
  return !!(
    message.isSender
    && (byPubkey || event.pubkey) === identity?.pk
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

// Step 1 receive (the door Step 1c left open on purpose): fetch the group's
// member-set doc events from both relay sets and verify each against the pin
// this device holds out of band. The relay's author field is checked first so
// a stranger's event never reaches AES work; the seal is opened with the
// invite-learned pin; rememberVerifiedDoc gates every at-rest write. Member
// devices hold ZERO docs today without this — publishDocOp refuses ('No
// member-set doc held') and standing falls back to the relay roster, which H4
// was written to end.
export async function refreshMemberDocs(identity, groupId) {
  if (!identity?.pk || !groupId) return null;
  const { readAuthorityPin } = await import('../lib/crypto/authorityPins.js');
  const { ingestMemberDocEvent } = await import('../lib/crypto/groupDocWire.js');
  const pin = readAuthorityPin(identity.pk, groupId);
  if (!pin) return null; // no pin held: nothing can verify; refuse quietly
  try {
    const pool = await getAuthenticatedPool(identity);
    // Both boxes: the group relay's copy and the cross-operator general-relay
    // mirror are equal candidates for verification — higher gen wins at rest,
    // so order does not matter and duplicates are idempotent rows.
    const targets = [...new Set([...groupRelays, ...generalRelays])].filter(Boolean);
    if (!targets.length) return null;
    const events = await queryWithTimeout(
      pool,
      targets,
      { kinds: [30079], '#d': [`cipher-gmemdoc:${groupId}`], limit: 50 },
      4000,
    ).catch(() => []);
    let stored = 0;
    for (const event of events) {
      const result = await ingestMemberDocEvent(event, { pin, groupId });
      if (result?.stored) stored += 1;
    }
    return { stored };
  } catch (error) {
    console.warn('[group] Member-set doc refresh failed:', error?.message || error);
    return null;
  }
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
    session.ws.send(JSON.stringify(['REQ', subId, ...filter]));
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
  session.pendingChallenge = challenge;
  // Step 2 (MEMBERSHIP-DESIGN.md): the proof that opens a group box is
  // signed by this account's per-group actor key, not by the account key.
  // signActProof builds it: kind 22242, relay + challenge tags, the author
  // pin riding alongside, all under the actor key.
  const gid = sessionActorGroupId(session);
  if (!gid) {
    console.warn('[NIP29] No open group to prove under; the challenge goes unanswered.');
    return;
  }
  signActProof({
    identity: session.identity,
    groupId: gid,
    relayUrl: session.relayUrl || currentGroupRelay(),
    challenge,
  }).then((signed) => {
    if (!signed || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
    session.actorPin = signed.pin;
    session.actorGid = gid;
    session.proofGroupId = '';
    session.pendingChallenge = '';
    session.authEventId = signed.event.id;
    session.authSent = true;
    session.ws.send(JSON.stringify(['AUTH', signed.event]));
  }).catch((error) => {
    console.error('[NIP29] Actor proof failed:', error);
    rejectAuthWaiters(session, error);
  });
}

// The group this socket's traffic should prove under. One socket carries every
// group this device follows, so the relay already reads the whole set off the
// REQ frames; WHICH group's already-known actor signs the proof decides only
// what the proof discloses. See lib/groupSocketProof for the rule and why the
// store's active group is deliberately not preferred. Nothing network-facing
// reads a value from storage here; this only picks which held actor signs.
// Exported with lib/groupSocketProof so the whole seam — held pin, live subs,
// held groups — is driven from the real tree rather than re-stated in a test.
export function sessionActorGroupId(session) {
  return socketProofGroupId({
    held: session.actorGid || session.proofGroupId || '',
    readable: groupIdsOnSession(session),
    known: (useChatStore.getState().groups || []).map((group) => group.id),
  });
}

// The group ids this socket currently reads. A subscriber's filter carries the
// group as an `#h` tag, one per sub; the sub id itself is client-side only.
// Exported with the rule above so the seam is driven directly, not re-stated.
export function groupIdsOnSession(session) {
  const ids = [];
  for (const [, filter] of session.subs || new Map()) {
    const tag = Array.isArray(filter)
      ? filter.flatMap((f) => f['#h'] || []).find(Boolean)
      : null;
    if (tag) ids.push(tag);
  }
  return ids;
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
    session.pendingChallenge = challenge || '';
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
    actorGid: '',
    proofGroupId: '',
    pendingChallenge: '',
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
  const eventGroupId = event.tags?.find((tag) => tag[0] === 'h' && tag[1])?.[1];
  if (!session.authed && !session.actorGid && eventGroupId) session.proofGroupId = eventGroupId;
  if (session.pendingChallenge && !session.authSent) sendAuthResponse(session, session.pendingChallenge);
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
  if (await isGroupRotationPending(groupId)) return;
  const items = securingSendsFor(identity.pk, groupId);
  // Step 2: the AAD binds the pin that will sit on the wire event
  // (groupCipher.aad() reads the sender field off the received event), so the
  // encoder folds the SAME actor pin that signs these kind-9s.
  const signer = await resolveActorSigner({ identity, groupId });
  if (!signer) {
    console.warn('[group-key] The waiting message has no signer (locked tab or unknown owner).');
    return;
  }
  for (const item of items) {
    const encoded = await encodeGroupPayload({ groupId: item.groupId, payload: item.payload, senderPubkey: signer.wireSender, by: identity.pk });
    if (encoded.pending) return;
    const tags = withGroupTag(item.groupId, encoded.tags);
    if (item.id) tags.push(['client', item.id]);
    if (item.replyId) tags.push(['e', item.replyId, '', 'reply']);
    // Step 2: the actor key signs the kind-9, never identity.sk.
    const event = await buildSignedAct({
      identity,
      groupId: item.groupId,
      content: encoded.content,
      tags,
    });
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
  const ownerPin = readAuthorityPin(identity.pk, groupId);
  if (!ownerPin) throw new Error('This private group needs an invite link from an admin. Ask them for a new link.');
  // The request remains a standard NIP-29 9021 actor-signed event. Its
  // account proof is NIP-44 encrypted to the out-of-band invite pin.
  const event = await buildAdmissionRequest({ identity, groupId, ownerPin });
  await publishAuthedGroupEvent(identity, event);
  return event;
}

export async function retrySecuringGroup(identity, groupId) {
  if (!identity?.sk || !groupId) throw new Error('Unlock your account first.');
  resetKeyRequest(identity.pk, groupId);
  // Step 2: actor-signed.
  const event = await buildSignedAct({
    identity,
    groupId,
    tags: [['h', groupId]],
    content: JSON.stringify({ type: 'gkey_req' }),
  });
  if (!event) throw new Error('No signer for the key request.');
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
    setAuthProofGroup(pool, groupId);

    const createdAt = Math.floor(Date.now() / 1000);

    // Step 2 slice 2: every creation control event is signed by this group's
    // freshly derived actor key — the same key the genesis doc names. The
    // creator's own device is also its first verifier (the pin is in scope).
    // Failure throws: a mixed-shape creation window would hand a relay-written
    // create event a legitimacy it has not earned.
    const signer = await resolveActorSigner({ identity, groupId });
    if (!signer) throw new Error('Unlock your account to create a group.');

    // The relay author is the group actor and the p-tag must name that same
    // pseudonym. Putting identity.pk here linked the account to the group.
    const tags = groupCreateTags({ name, about, isChannel, access, joinPolicy, groupId, pubkey: signer.wireSender });

    // A private governance document must be sealable before any create event
    // reaches a relay. Never create a group whose genesis can only be
    // published under the publicly derivable historical v1 key.
    let genesisDocKey = null;
    try {
      const heldDocKey = await getDocKey(groupId);
      if (heldDocKey) {
        genesisDocKey = normalizeDocKey(heldDocKey.bytes);
      } else {
        const generatedDocKey = generateDocKey();
        if (await putDocKey(groupId, 1, generatedDocKey)) {
          genesisDocKey = normalizeDocKey((await getDocKey(groupId))?.bytes);
        }
      }
    } catch (docKeyError) {
      console.warn('[createGroup] Could not secure the governance-doc key:', docKeyError?.message || docKeyError);
    }
    if (!genesisDocKey) {
      throw new Error('Could not securely store this group’s governance key. No group was published; unlock storage and retry.');
    }

    const createEv = await buildControlAct({
      identity, groupId, kind: 9007,
      tags: tags.create, createdAt, signer: { skBytes: signer.skBytes, pin: signer.pin },
    });

    const r9007 = await Promise.allSettled(pool.publish(groupRelays, createEv));
    const ok = r9007.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('No relay accepted 9007');

    const metaEv = await buildControlAct({
      identity, groupId, kind: 9002,
      tags: tags.meta, createdAt, signer: { skBytes: signer.skBytes, pin: signer.pin },
    });
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
      const policyEv = await buildControlAct({
        identity, groupId, kind: 9002,
        tags: tags.meta, createdAt: createdAt + 1, signer: { skBytes: signer.skBytes, pin: signer.pin },
      });
      await Promise.allSettled(pool.publish(groupRelays, policyEv));
    }

    const joinEv = await buildControlAct({
      identity, groupId, kind: 9021,
      tags: tags.join, createdAt, content: 'Creator', signer: { skBytes: signer.skBytes, pin: signer.pin },
    });
    await Promise.allSettled(pool.publish(groupRelays, joinEv));

    try {
      const existing = await getCurrentGroupKey(groupId);
      if (!existing) {
        const key = generateGroupKey();
        await putGroupKey(groupId, 1, key);
        await distributeGroupKey({
          senderPrivkey: identity.sk, senderPubkey: identity.pk,
          groupId, epoch: 1, keyBytes: key, recipients: [identity.pk],
          docKey: genesisDocKey,
          // The real name and description travel sealed, in the same envelope
          // as the key. On a public group `sealed` is null and this is the
          // bundle it has always been.
          label: tags.sealed,
          publish: (dmEvent) => publishKeyDm(identity, dmEvent),
        });
        await rememberMembers(groupId, [identity.pk]);
      }
    } catch (e) { console.warn('[createGroup] key bootstrap deferred', e); }

    const newGroup = { id: groupId, name, about: about || '', isChannel, access, creator: identity.pk, members: [identity.pk], metaAt: metaEv.created_at, ...(tags.sealed ? { labelSealed: true } : {}) };
    const saveCreatedGroup = () => {
      const localGroups = getMyGroups(identity.pk);
      if (!localGroups.find((group) => group.id === groupId)) {
        localGroups.push(newGroup);
        setMyGroups(identity.pk, localGroups);
      }
      setGroups(prev => [newGroup, ...(prev || []).filter(g => g.id !== groupId)]);
    };

    // Step 1 issuance (MEMBERSHIP-DESIGN.md): derive this group's authority
    // key from the account secret, stamp its pin for every later invite link,
    // sign the genesis member-set doc naming only this account, and publish
    // it to both relay sets. A publish failure is surfaced, and the group row
    // stays local with its held key and signed doc so recovery can be retried.
    try {
      const { groupAuthorityKey } = await import('../lib/crypto/groupAuthority.js');
      const { genesisDocBody, signDocEvent } = await import('../lib/crypto/groupDoc.js');
      const { buildMemberDocEvent, rememberVerifiedDoc } = await import('../lib/crypto/groupDocWire.js');
      const { rememberAuthorityPin } = await import('../lib/crypto/authorityPins.js');
      const skBytes = identity.sk instanceof Uint8Array ? identity.sk : Uint8Array.from(identity.sk);
      const { privateKeyBytes, pin } = await groupAuthorityKey(skBytes, groupId);
      rememberAuthorityPin(identity.pk, groupId, pin);
      // Step 2 slice 3: the genesis row names this account's actor pin beside
      // it — the same key that signs this device's kind-9s and docs. Every
      // later member stamps its own through the admit path when the doc's
      // publisher has verified the (account -> pin) pair out of band.
      const body = await genesisDocBody({
        gid: groupId,
        epoch: 1,
        creator: identity.pk.toLowerCase(),
        members: [identity.pk.toLowerCase()],
        actorPins: { [identity.pk.toLowerCase()]: pin },
      });
      const signed = await signDocEvent(body, privateKeyBytes);
      const nowSec = Math.floor(Date.now() / 1000);
      await rememberVerifiedDoc({ groupId, pin, signed });
      const docEv = await buildMemberDocEvent({
        signedDoc: signed, authoritySk: privateKeyBytes, pin, groupId, createdAt: nowSec,
        docKey: genesisDocKey,
      });
      if (!docEv) throw new Error('Could not build the encrypted genesis member document.');
      const targets = [...new Set([...groupRelays, ...generalRelays])];
      const results = await Promise.allSettled(pool.publish(targets, docEv));
      if (!results.some((result) => result.status === 'fulfilled')) {
        throw new Error('No relay accepted the encrypted genesis member document.');
      }
    } catch (e) {
      console.error('[createGroup] Group was created, but its encrypted genesis member document was not confirmed. The held key and signed local document remain available for recovery.', e);
      saveCreatedGroup();
      throw new Error('The group was created, but its encrypted membership document could not be published. It remains on this device; restore relay access and retry recovery before inviting members.');
    }

    appendSystemMessage(groupId, 'You created the group');
    // metaAt marks the bootstrap 9002 as the applied metadata: a replayed
    // older or equal metadata event must not announce a fake rename.
    // labelSealed marks a row whose name came from this device's own record
    // rather than from the relay's tags. On a private group the tags carry the
    // fixed placeholder, so every path that could refill the name from the
    // relay has to know not to.
    saveCreatedGroup();

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
    // Step 1 receive: the join is when this device first holds a pin (invite
    // link stamped at bootstrap, or owner derivation at create). Fetch and
    // verify the group's member-set doc now so standing reads doc-backed from
    // the first membership decision instead of falling back to the roster.
    refreshMemberDocs(identity, groupId).catch(() => {});
    return newGroup;
  }, [identity, setGroups]);

  const leaveGroup = useCallback(async (groupId) => {
    const pool = await getAuthenticatedPool(identity);
    const known = await loadVerifiedMemberSnapshot(groupId);
    if (!Array.isArray(known)) throw new Error('This device has no verified membership document. Restore it before leaving.');
    const remaining = known.map(memberKey).filter((pubkey) => pubkey && pubkey !== identity.pk);
    try {
      const rotation = await rotateGroupEpoch({
        identity,
        groupId,
        remainingPubkeys: remaining,
        publish: (dmEvent) => publishKeyDm(identity, dmEvent),
      });
      if (!rotation?.rotated) {
        const reason = rotation?.reason === 'missing-doc-key'
          ? 'This group has no readable governance key. Recover it from an authorized member before leaving.'
          : rotation?.reason === 'missing-member-doc'
            ? 'This device has no verified membership document. Restore it from the group relays before leaving.'
          : 'The group key could not be rotated safely. Your membership was not changed; unlock storage and retry.';
        throw new Error(reason);
      }
    } catch (error) {
      console.error('[group-key] Could not rotate the key after a member left:', error);
      throw error;
    }
    // Step 2 slice 2: a leave is a group act; the actor key signs it.
    const leaveEv = await buildControlAct({
      identity, groupId, kind: 9022,
      tags: [['h', groupId]],
    });
    if (!leaveEv) throw new Error('Unlock your account before leaving.');
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
      if (await isGroupRotationPending(groupId)) {
        return { success: false, error: 'Group key rotation is recovering. Sending is paused until the remaining members receive the new key.' };
      }
      // Step 2: resolve the actor once; the SAME pin folds into the group
      // cipher's AAD and signs the event. Two derivations racing here would
      // produce an event a receiver cannot open.
      const signer = await resolveActorSigner({ identity, groupId });
      if (!signer) throw new Error('Unlock your account to write in this group.');
      const encoded = await encodeGroupPayload({ groupId, payload, senderPubkey: signer.wireSender, by: identity.pk, waitForKey: true });
      if (encoded.pending) {
        if (clientId) queueSecuringSend(identity.pk, { id: clientId, groupId, payload, replyId, since: Date.now() });
        // Drills D4: the keyless install floor opens on this record — it is
        // the evidence that this device itself asked for the key.
        rememberPendingKeyRequest(identity.pk, groupId);
        try {
          // Step 2: the key request is a group act too; the actor signs it.
          const reqEvent = await buildSignedAct({
            identity,
            groupId,
            tags: withGroupTag(groupId),
            content: JSON.stringify({ type: 'gkey_req' }),
          });
          if (!reqEvent) throw new Error('No signer for the key request.');
          await publishAuthedGroupEvent(identity, reqEvent);
        } catch (error) {
          console.error('[NIP29] Failed to request a group key:', error);
        }
        return { success: false, error: 'NO_KEY' };
      }
      const tags = withGroupTag(groupId, encoded.tags);
      if (clientId) tags.push(['client', clientId]);
      if (replyId) tags.push(['e', replyId, '', 'reply']);
      // Step 2: the actor key signs the message; identity.sk never reaches
      // a group relay. Same wire shape otherwise.
      const event = await buildSignedAct({
        identity,
        groupId,
        content: encoded.content,
        tags,
        signer: { skBytes: signer.skBytes, pin: signer.pin },
      });
      if (!event) throw new Error('This group message has no signer: unlock your account.');
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
      // Step 2: actor-signed, like every kind-9 on this box now.
      const ev = await buildSignedAct({
        identity,
        groupId,
        tags: withGroupTag(groupId),
        content: JSON.stringify({ type: 'gkey_req' }),
      });
      if (!ev) throw new Error('No signer for the key request.');
      await publishAuthedGroupEvent(identity, ev);
    } catch (error) {
      console.error('[group] Key request did not send:', error);
    }
  }, [identity]);

  const sendGroupTypingIndicator = useCallback(async (groupId) => {
    if (!allowsTyping()) return;
    try {
      if (await isGroupRotationPending(groupId)) return;
      // Step 2: the typing act is encrypted under the SAME actor pin that
      // signs it, because receivers derive the cipher AAD from event.pubkey.
      const signer = await resolveActorSigner({ identity, groupId });
      if (!signer) return;
      const encoded = await encodeGroupPayload({ groupId, payload: { type: 'typing' }, senderPubkey: signer.wireSender, by: identity.pk });
      if (encoded.pending) return;
      // Step 2: actor-signed.
      const ev = await buildSignedAct({
        identity,
        groupId,
        tags: withGroupTag(groupId, encoded.tags),
        content: encoded.content,
      });
      if (!ev) return;
      await publishAuthedGroupEvent(identity, ev);
    } catch (e) {}
  }, [identity]);

  const kickMember = useCallback(async (groupId, memberPubkey) => {
    // Drills D3-B: a kick is a durable removal, not a snapshot edit. The
    // rotation rotated, but the grant path read only the deny list — and
    // the kick never wrote one — so a replayed 9021 into an open-join
    // relay re-armed the kicked peer and shipped them the post-kick epoch.
    // The removal rides the same durable record the deny path uses.
    const targetPin = await actorPinForMember(identity, groupId, memberPubkey);
    if (!targetPin) throw new Error('This member has no verified group identity yet. Refresh the membership document before removing them.');
    denyPendingJoin(groupId, memberPubkey);
    const pool = await getAuthenticatedPool(identity);
    const allMembers = await loadVerifiedMemberSnapshot(groupId);
    if (!Array.isArray(allMembers)) throw new Error('This device has no verified membership document. Restore it before removing anyone.');
    if (!allMembers.some((member) => memberKey(member) === String(memberPubkey).toLowerCase())) {
      throw new Error('This person is not in the verified membership document. Refresh the group and retry.');
    }
    const remaining = allMembers.map(memberKey).filter((pubkey) => pubkey !== String(memberPubkey).toLowerCase());
    if (!remaining.includes(identity.pk)) remaining.push(identity.pk);
    try {
      const rotation = await rotateGroupEpoch({
        identity,
        groupId,
        remainingPubkeys: remaining,
        publish: (dmEvent) => publishKeyDm(identity, dmEvent),
      });
      if (!rotation?.rotated) {
        const reason = rotation?.reason === 'missing-doc-key'
          ? 'This group has no readable governance key. Recover it from an authorized member before removing anyone.'
          : rotation?.reason === 'missing-member-doc'
            ? 'This device has no verified membership document. Restore it from the group relays before removing anyone.'
          : 'The group key could not be rotated safely. No member was removed; unlock storage and retry.';
        throw new Error(reason);
      }
    } catch (error) {
      console.error('[group-key] Could not rotate the key after a kick:', error);
      throw error;
    }
    // Step 2 slice 2: a kick is a group act; the actor key signs it.
    const ev = await buildControlAct({
      identity, groupId, kind: 9001,
      tags: [['h', groupId], ['p', targetPin.slice(2)]],
    });
    if (!ev) throw new Error('Unlock your account first.');
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.filter(m => m.pubkey !== memberPubkey));
    appendSystemMessage(groupId, `${shortNpub(memberPubkey)} was kicked from the group`, ev.id);
  }, [identity, setGroupMembers, appendSystemMessage]);

  const promoteMember = useCallback(async (groupId, memberPubkey, isAdmin) => {
    const standing = await loadVerifiedMemberSnapshot(groupId);
    if (!Array.isArray(standing)) throw new Error('This device has no verified membership document. Restore it before changing roles.');
    const account = String(memberPubkey || '').toLowerCase();
    const target = standing.find((member) => memberKey(member) === account);
    if (!target) throw new Error('This person is not in the verified membership document.');
    const targetPin = await actorPinForMember(identity, groupId, memberPubkey);
    if (!targetPin) throw new Error('This member has no verified group identity yet. Refresh the membership document before changing their role.');
    const nextRole = isAdmin ? 'member' : 'admin';
    // Governance standing is authoritative. Publish its signed role first;
    // if the relay control event is refused, authorization is already changed
    // and the user can retry the idempotent relay update.
    await publishMemberDocUpdate(groupId, standing, { roleChanges: { [account]: nextRole } });
    // Step 2 slice 2: a role change is a group act.
    const ev = await buildControlAct({
      identity, groupId, kind: 9000,
      tags: [['h', groupId], ['p', targetPin.slice(2)], ['role', nextRole]],
    });
    if (!ev) throw new Error('Unlock your account first.');
    const pool = await getAuthenticatedPool(identity);
    const results = await Promise.allSettled(pool.publish(groupRelays, ev));
    if (!results.some((result) => result.status === 'fulfilled')) {
      throw new Error('The signed governance role changed, but the relay roster update was refused. Retry the role action after relay access returns.');
    }
    setGroupMembers(prev => prev.map(m => m.pubkey === memberPubkey ? { ...m, role: nextRole } : m));
    appendSystemMessage(groupId, `${shortNpub(memberPubkey)} was ${nextRole === 'member' ? 'demoted to member' : 'promoted to admin'}`, ev.id);
  }, [identity, setGroupMembers, appendSystemMessage]);

  const addMember = useCallback(async (groupId, memberPubkey) => {
    const pending = pendingJoinsFor(groupId).find((row) => row.pubkey === String(memberPubkey || '').toLowerCase());
    let admittedPin = '';
    if (pending) {
      if (!pending.requestEvent) throw new Error('This request needs to be sent again before it can be approved.');
      const proof = await openAdmissionRequest({ identity, groupId, event: pending.requestEvent });
      if (proof.accountPubkey !== String(memberPubkey || '').toLowerCase()
        || proof.actorPin !== pending.actor || proof.nonce !== pending.nonce
        || proof.eventId !== pending.eventId) {
        throw new Error('The admission request could not be matched to this person. Ask them to send a new request.');
      }
      admittedPin = proof.actorPin;
    }
    const targetPin = admittedPin || await actorPinForMember(identity, groupId, memberPubkey);
    if (!targetPin || !/^0[23][0-9a-f]{64}$/.test(targetPin)) {
      throw new Error('This person has not sent a private admission request. Ask them for a new group invite request.');
    }
    const observedPins = { [String(memberPubkey).toLowerCase()]: targetPin };
    const snapshot = await loadVerifiedMemberSnapshot(groupId);
    if (!Array.isArray(snapshot)) throw new Error('This device has no verified membership document. Restore it before approving a member.');
    const nextMembers = [...new Map([...snapshot, memberPubkey, identity.pk]
      .map((member) => [memberKey(member), member])
      .filter(([pubkey]) => /^[0-9a-f]{64}$/.test(pubkey))).values()];
    // Publish the signed authorization first. If this fails, no relay control
    // event is sent and the pending request remains available for retry.
    await publishMemberDocUpdate(groupId, nextMembers, { pins: observedPins });
    await rememberMembers(groupId, nextMembers, { pins: observedPins, strict: true, publishDoc: false });
    // Step 2 slice 2: an add-back receipt is a group act. Same kind the kick
    // wall's receiver arm reads to clear its own removal record — an actor-
    // signed receipt resolves through standing rows' actor field exactly like
    // every other control event now does.
    const ev = await buildControlAct({
      identity, groupId, kind: 9000,
      tags: [['h', groupId], ['p', targetPin.slice(2)]],
    });
    if (!ev) throw new Error('Unlock your account first.');
    const pool = await getAuthenticatedPool(identity);
    // The publish outcome decides the relay roster row. If every relay rejected the add,
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
    queueMemberBaseline(groupId, nextMembers);
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
    // Step 2 slice 2: a metadata edit is a group act.
    const ev = await buildControlAct({ identity, groupId, kind: 9002, tags });
    if (!ev) throw new Error('Unlock your account first.');
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
      // Step 1 live arm: every roster read is also the moment a newer doc
      // generation would arrive. Same verify-then-store door as the join
      // fetch — nothing trusts an unverified row. Fire-and-forget: the roster
      // read below does not wait on it, and a failure here is a warn, not a
      // refused roster (H4's fallback law stands until the doc verifies).
      refreshMemberDocs(identity, groupId).catch(() => {});
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
      const relayMembers = pickMemberSnapshot([...byDTag, ...byHTag], relayPubkey, groupId);
      const standing = await loadMemberSnapshot(groupId).catch(() => null);
      const members = withoutDenied(groupId, mapRelayRosterToAccounts(relayMembers, standing));
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
        // marker, the screen shows no count rather than a guess. The list is
        // handed over so the store can refuse an empty one: zero is a number
        // the screen may only print when a read measured zero members, and a
        // group this device is in always has at least this device in it.
        useChatStore.getState().setGroupMembersKnown(groupId, members);
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
      // The doc's d-tag names the group with a prefix (its h-less shape is
      // why it needs this arm at all): strip it so every later check below
      // sees the bare gid. A bare d-tag stays untouched.
      let groupId = event.tags.find((tag) => tag[0] === 'h')?.[1] || event.tags.find((tag) => tag[0] === 'd')?.[1] || '';
      if (groupId.startsWith(MEMBER_DOC_D_PREFIX + ':')) groupId = groupId.slice(MEMBER_DOC_D_PREFIX.length + 1);
      if (!groupId || !groupIds.includes(groupId)) return;
      // Step 2 slice 3, live arm: an ingested doc re-folds its (account ->
      // pin) rows into every future control authorization and key-DM
      // send-off; verify-then-store is inside ingestMemberDocEvent.
      if (event.kind === MEMBER_DOC_KIND) {
        refreshMemberDocs(identity, groupId).catch(() => {});
        return;
      }
      if (event.kind === 39002) {
        const relayPubkey = await groupRelayPubkey();
        if (!authorizeMemberSnapshot({ event, relayPubkey })) {
          console.warn('[group] Ignored a membership snapshot not signed by the group relay', event.id);
          return;
        }
        // An open-join relay names a denied sender in its snapshot; the local
        // deny outvotes the relay, so their row never lands or grants a key.
        const relaySnapshot = pickMemberSnapshot([event], relayPubkey, groupId) || [];
        const standing = await loadMemberSnapshot(groupId).catch(() => null);
        const relayMembers = withoutDenied(groupId, mapRelayRosterToAccounts(relaySnapshot, standing));
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
          // Same rule as the read above, and this is the arm that can hand
          // over an empty list: withoutDenied strips every row this device
          // denied, so an all-denied roster arrives here as []. That is not
          // evidence of zero members, and the store refuses to mark it.
          useChatStore.getState().setGroupMembersKnown(groupId, members);
        }
        return;
      }
      if (event.kind === 9021) {
        const { members } = await controlContext(groupId, identity.pk);
        const knownSender = resolveControlSender({ wirePubkey: event.pubkey, members });
        if (!knownSender) {
          // First-contact actor pins are intentionally not resolvable from a
          // relay roster. Only the owner can open the NIP-44 body; the inner
          // account signature binds account, actor, group and one-time nonce.
          try {
            const queued = pendingJoinsFor(groupId);
            const opened = await openAdmissionRequest({
              identity,
              groupId,
              event,
              seenNonces: new Set(queued.map((row) => row.nonce).filter(Boolean)),
            });
            if (opened.accountPubkey === identity.pk || isJoinDenied(groupId, opened.accountPubkey)) return;
            if (!allowsGroupJoins()) {
              denyPendingJoin(groupId, opened.accountPubkey);
              return;
            }
            const added = queuePendingJoin(groupId, {
              pubkey: opened.accountPubkey,
              actor: opened.actorPin,
              nonce: opened.nonce,
              eventId: event.id,
              at: event.created_at,
              requestEvent: event,
            });
            if (added) {
              const owned = useChatStore.getState().groups.some((g) => g.id === groupId && g.creator === identity.pk);
              if (owned) appendSystemMessage(groupId, `${shortNpub(opened.accountPubkey)} wants to join. Approve it in Join requests.`, event.id);
            }
          } catch (error) {
            // Other members and non-owners see the same relay event but do
            // not hold the authority secret needed to decrypt this proof.
            console.warn('[group] Ignored an unverified private admission request:', error?.message || error);
          }
          return;
        }
      }
      let resolvedSender = '';
      let resolvedSubject = '';
      if ([9000, 9001, 9002, 9021, 9022].includes(event.kind)) {
        const { creator, members } = await controlContext(groupId, identity.pk);
        // Step 2 slice 2: the sender resolves through standing rows first —
        // an actor-signed control event carries its account only via the doc's
        // (account -> pin) map; a legacy event still signs with the account
        // key itself and matches directly. An unresolvable sender answers ''
        // and authorizeGroupControl refuses it — a verified signature alone
        // never promotes anyone.
        resolvedSender = resolveControlSender({ wirePubkey: event.pubkey, members });
        const rawSubject = event.tags.find((tag) => tag[0] === 'p')?.[1] || '';
        resolvedSubject = event.kind === 9021 || event.kind === 9022
          ? (resolvedSender || event.pubkey)
          : (resolveControlSender({ wirePubkey: rawSubject, members }) || '');
        if (([9000, 9001].includes(event.kind) && !resolvedSubject)
          || !authorizeGroupControl({ kind: event.kind, sender: resolvedSender, subject: resolvedSubject, members, creator })) {
          console.warn('[group] Ignored an unauthorized membership event', event.kind, event.id);
          return;
        }
      }

      if (event.kind === 9021) {
        // Gate-verified above; the actor-signed shape names the account here.
        const pk = resolvedSender || event.pubkey;
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
        const pk = resolvedSender || event.pubkey;
        await patchMemberSnapshot(groupId, (members) => members.filter((member) => member !== pk));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
        }
        appendSystemMessage(groupId, `${shortNpub(pk)} left the group`, event.id);
        return;
      }
      if (event.kind === 9000) {
        const pk = resolvedSubject;
        const standing = await loadVerifiedMemberSnapshot(groupId);
        const governanceMember = Array.isArray(standing)
          ? standing.find((member) => memberKey(member) === pk)
          : null;
        if (!governanceMember) return;
        const role = typeof governanceMember === 'object' && governanceMember.role === 'admin' ? 'admin' : 'member';
        // The receiver arm of the kick wall: the add-back receipt an admin
        // addresses to THIS device is what clears its own removal record —
        // nothing else on this device un-walls it (drills D2 receiver arm).
        if (pk && String(pk) === String(identity.pk)) clearJoinDenial(groupId, identity.pk);
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
        const pk = resolvedSubject;
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

      // The shared group message key means `by` is an attribution claim, not
      // proof. Only the signed governance binding (or a legacy direct account
      // signer) resolves an actor to an account.
      const messageMembers = await loadVerifiedMemberSnapshot(groupId);
      const decoded = await decodeGroupEvent({
        event, groupId, members: messageMembers, requireMember: true,
      });
      if (decoded.refused) {
        console.warn('[group] Dropped a message from outside verified current membership', event.id);
        return;
      }
      const actBy = decoded.sender;

      const blocked = useChatStore.getState().blockedUsers || [];
      if (blocked.includes(actBy) && actBy !== identity.pk) return;

      let isGkeyReq = false;
      try {
        const parsedQuick = JSON.parse(event.content);
        if (parsedQuick.type === 'gkey_req') {
          isGkeyReq = true;
          // SEC-2: the requester is resolved through the SAME verified bindings
          // control acts use — wire actor pin (or account key) matched against
          // roster rows. The sealed body's `by` is a claim by the actor key
          // holder, not a binding, so it only stands in when the wire actor is
          // unbound AND the claim names a member of record. The resolved
          // requester is the account the bundle is addressed to: only that
          // account's devices can open a key DM.
          const record = await loadMemberSnapshotRecord(groupId);
          const requesterMembers = messageMembers;
          const requester = resolveKeyRequestRequester({
            wirePubkey: event.pubkey,
            bodyBy: actBy,
            members: requesterMembers,
          });
          if (requester && requester !== identity.pk) {
            const current = await getCurrentGroupKey(groupId);
            const { creator } = await controlContext(groupId, identity.pk);
            const decision = await grantKeyRequest({
              groupId,
              requester,
              creator,
              // F3: the device's own creation record is the one self-attested
              // standing; even a relay outage cannot take the owner's grant.
              selfCreated: useChatStore.getState().groups.some((it) => it.id === groupId && it.creator === identity.pk),
              // A relay list cannot authorize a key grant when the verified
              // governance document is unavailable.
              snapshot: requesterMembers,
              updatedAt: record?.updatedAt,
              keyObtainedAt: current?.obtainedAt,
              fetchMembers: () => fetchRelayMemberSnapshot(identity, groupId),
            });
            if (decision === 'allow' && current) {
              await distributeGroupKey({
                senderPrivkey: identity.sk, senderPubkey: identity.pk,
                groupId, epoch: current.epoch, keyBytes: current.bytes,
                recipients: [requester],
                // An explicit request is answered whatever the ledger says
                // was sent before, but only for the current epoch. New members
                // and returning devices do not receive automatic history.
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

      // A local actor key is known by derivation. Other account mappings must
      // come from the verified governance document, never the shared-key body.
      const ownActor = await resolveActorSigner({ identity, groupId });
      const docSender = resolveControlSender({ wirePubkey: event.pubkey, members: messageMembers });
      const actByClamped = docSender || (event.pubkey === ownActor?.wireSender ? identity.pk : event.pubkey);

      if (!isPending && parsed.type === 'typing') {
        const age = (Date.now() / 1000) - event.created_at;
        if (age < 10 && actByClamped !== identity.pk) {
          setGroupTypingUsers(prev => ({ ...prev, [actByClamped]: Date.now() }));
        }
        return;
      }

      if (actByClamped !== identity.pk) {
        setGroupMembers(prev => {
          if (prev.findIndex(m => m.pubkey === actByClamped) === -1) {
            return [...prev, { pubkey: actByClamped, role: 'member' }];
          }
          return prev;
        });
      }

      const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
      const clientId = event.tags.find(t => t[0] === 'client')?.[1];

      if (actByClamped === identity.pk && clientId) {
        const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
        if (optimisticMessage?.chatId === groupId && optimisticMessage.isSender && optimisticMessage.id !== event.id) {
          await db.messages.delete(optimisticMessage.id);
        }
      }

      setGroupMessages(prev => {
        const groupMsgs = prev[groupId] || [];
        const existingIndex = groupMsgs.findIndex((m) => sameOutgoingMessage(m, event, identity, clientId, actByClamped));

        const baseMsg = stampArrival({
          id: event.id, clientId, isSender: actByClamped === identity.pk,
          pubkey: actByClamped, timestamp: event.created_at,
          deliveryStatus: actByClamped === identity.pk ? 'sent' : undefined,
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
        if (actByClamped !== identity.pk && useChatStore.getState().activeGroup?.id === groupId) {
          markChatRead(groupId, Math.max(Math.floor(Date.now() / 1000), event.created_at));
        }
        if (actByClamped !== identity.pk && !isPending && !shouldSuppressGroup(groupId)) {
          let isReplyToMe = false;
          let isMentioned = false;
          if (replyTag) {
            const msgs = useChatStore.getState().groupMessages[groupId] || [];
            const originalMsg = msgs.find(m => m.id === replyTag[1]);
            isReplyToMe = originalMsg && originalMsg.isSender;
          }
          try {
            const myProfile = useChatStore.getState().profiles[identity.pk];
            // The published handle record is the fallback: my own profile only
            // reaches the store once a group has carried a message of mine, so
            // without this a mention in the first exchange is not seen. The
            // record is read at boot (useChatBootstrap) for exactly this.
            const myUsername = myProfile?.name || myProfile?.username || useChatStore.getState().myUsername;
            if (myUsername && parsed.message && parsed.message.includes('@' + myUsername)) isMentioned = true;
          } catch (e) {}
          // S11: the sender is the throttle key; only the OS notification is held back.
          if (isReplyToMe) showNotification(`💬 Reply in ${groupId.slice(0, 6)}`, actByClamped);
          else if (isMentioned) showNotification('📣 You were mentioned', actByClamped);
          else showNotification('New Group Message', actByClamped);
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
          const standingMembers = await loadVerifiedMemberSnapshot(gid);
          const decoded = await decodeGroupEvent({
            event, groupId: gid, members: standingMembers, requireMember: true,
          });
          if (decoded.refused || decoded.pending || decoded.error) continue;
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
          // Historical messages use the same verified actor binding rule as
          // live frames; body `by` is not identity evidence.
          const actBy = decoded.sender;
          setGroupMessages(prev => {
            const groupMsgs = prev[gid] || [];
            const idx = groupMsgs.findIndex((m) => sameOutgoingMessage(m, event, identity, clientId, actBy));
            const newMsg = stampArrival({
              id: event.id, clientId, isSender: actBy === identity.pk,
              pubkey: actBy, timestamp: event.created_at,
              deliveryStatus: actBy === identity.pk ? 'sent' : undefined,
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
    // A temp- id is this device's own placeholder for a row still sending
    // or securing. A kind-9005 e-tag pointing at it can never resolve for
    // any peer, and the row's id changes the moment the relay answers, so
    // the pin would dangle locally too. Wait for the row to send.
    if (typeof messageEventId === 'string' && messageEventId.startsWith('temp-')) {
      throw new Error('This item is still sending.');
    }
    // S9: the pinned slot belongs to the group, so it moves only for a
    // creator or admin — the same standing the membership control kinds
    // demand. A member's pin goes nowhere and moves no one's slot.
    const standing = await controlContext(groupId, identity.pk);
    if (!authorizeGroupPin({ sender: identity.pk, members: standing.members, creator: standing.creator })) {
      throw new Error('Only the group owner or an admin can pin.');
    }
    const pool = await getAuthenticatedPool(identity);
    // Step 2 slice 2: a pin is a group act (S9 standing checked above).
    const ev = await buildControlAct({
      identity, groupId, kind: 9005,
      tags: [['h', groupId], ['e', messageEventId]],
    });
    if (!ev) throw new Error('Unlock your account first.');
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
    // Step 2 slice 2: an unpin is a group act too.
    const ev = await buildControlAct({
      identity, groupId, kind: 9005,
      tags: [['h', groupId]],
      content: 'unpin',
    });
    if (!ev) throw new Error('Unlock your account first.');
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
      // Step 2 slice 2: the creator's pin event is authored by their actor
      // key's x-only form once captured, so the dedicated filter asks for BOTH
      // author shapes; a creator with no row pin yet matches by account only.
      const ownerAuthorFilter = standing.creator
        ? await (async () => {
          const row = (standing.members || []).find((m) => (typeof m === 'object' && m?.pubkey) === String(standing.creator).toLowerCase());
          const heldActorPin = actorPinOfRow(row);
          let actor = heldActorPin ? heldActorPin.slice(2) : null;
          if (!actor && String(standing.creator).toLowerCase() === identity.pk.toLowerCase()) {
            // Wire-capture finding, second leg: on this creator's own device
            // the pin is known by construction (creation stamped it), but a
            // fresh snapshot can still hold plain string rows, which left
            // the account arm shipping four REQ frames that named the
            // account on the group box. The held out-of-band pin answers.
            const { readAuthorityPin } = await import('../lib/crypto/authorityPins.js');
            const held = readAuthorityPin(identity.pk, groupId);
            if (/^[0-9a-f]{66}$/.test(held || '')) actor = held.slice(2);
          }
          // If no actor mapping is held, use no author filter. Asking by the
          // account key would disclose the group/account link to the relay.
          return { kinds: [9005], '#h': [groupId], ...(actor ? { authors: [actor] } : {}), limit: 10 };
        })()
        : null;
      const [ownerEvents, memberEvents] = await Promise.all([
        ownerAuthorFilter ? read(ownerAuthorFilter) : [],
        read({ kinds: [9005], '#h': [groupId], limit: 500 }),
      ]);
      const pin = pinnedMessageOf(ownerEvents, memberEvents, (event) => (
        // Step 2 slice 2: actor-shaped pin events resolve through rows first.
        authorizeGroupPin({
          sender: resolveControlSender({ wirePubkey: event.pubkey, members: standing.members }),
          members: standing.members,
          creator: standing.creator,
        })
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
    refreshMemberDocs,
  };
}

