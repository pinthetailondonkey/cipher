import { useCallback, useEffect } from 'react';
import { db, openDBFor, saveMessage, saveMessageOnce, markSentMessagesRead, markChatRead } from '../db';
import { countsAsNewUnread } from '../lib/unreadCounts';
import { receiptTime } from '../lib/messageMerge';
import { dmControlAction, dmExpired, installMemberGroupKey } from './useGroupKeyMember';
import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryAllPages } from '../lib/relays';
import { publishWriteAhead, startOutboxSync } from '../lib/outbox';
import { completeMessageEffect, reserveMessageEffect } from '../lib/idempotentMessageEffect.js';
import { allowsTyping } from '../lib/privacy';
import { publishOwnRelayList, relaysForPeer } from '../lib/dmRelays';
import { sortMessages, stampArrival } from '../features/chat/media';
import { rumorTags, sealAndWrap, withBuzzLabel, wrapForGateway, buzzLabelFor, GIFT_WRAP_KIND, padRumorContent, unpadRumorBody } from '../lib/giftWrap';
import { openDmTransportEvent } from '../lib/giftUnwrap';
import { storedGatewayPubkey as activeGatewayPubkey } from '../lib/pushGatewayStore';
import { conversationKey } from '../lib/dmKeys';
import { dmSubscriptionFilters } from '../lib/dmSubscription';
import { noteFirstSeen } from '../lib/safetyNumber';
import { clampedExpiresAt } from '../lib/disappearing';
import { acceptPayment, rememberPublicView, receiptBindsOrder, sendCountersignOnce, stripArrivingReceiptMark } from '../lib/proofOfTrade';
import { deviceWatchedOrderOf, orderRecordForReceipt } from '../lib/orderActions';
import { scopedSetVerified } from '../lib/storage';
import { assertSecurityContextOwner } from '../lib/securityContextFence';
import { allowsProtocolTestDm } from '../lib/privacy';

import { getPublicKey } from 'nostr-tools/pure';

function assertIdentityCurrent(identity) {
  assertSecurityContextOwner(identity?.securityFence, identity?.pk);
}

function sendCountersign(sendDM, counterparty, orderId, accepted) {
  return sendCountersignOnce({
    sendDM,
    counterparty,
    orderId,
    accepted,
    onFailure: (error) => {
      console.error('[orders] The buyer signature was not sent:', error);
      useChatStore.getState().setToast({
        type: 'error',
        message: 'Your signature on the payment receipt did not send. Cipher will try again the next time it loads your chats.',
      });
    },
  });
}

const shouldSuppress = (chatId) => {
  const state = useChatStore.getState();
  const mutedUntil = state.mutedUntil?.[chatId];
  const isMuted = mutedUntil === 'forever' || (mutedUntil && mutedUntil > Date.now());
  const isArchived = state.archivedChats?.includes(chatId);
  return isMuted || isArchived;
};

function dmEffectPayload(payload = {}) {
  const normalized = { ...payload };
  if (normalized.receipt?.hash) normalized.receipt = { hash: normalized.receipt.hash };
  if (normalized.published?.hash) normalized.published = { hash: normalized.published.hash };
  return normalized;
}

// ── Test-profile DM lane (per-account opt-in, Privacy > Test-profile DM lane)
//
// When the flag is ON a plain text DM is wrapped by the FROZEN test-profile
// wire (docs/DM-TEST-PROFILE-V1.md): kind 14 rumor -> kind 13 seal signed by
// a device key -> kind 1059 wrap, with the operation digest bound inside the
// Olm payload. The wrap publishes to the account's relay list like any send.
// There is NO fallback to the legacy path while the flag is on: if the wire
// build fails the send fails with its reason. Non-text payloads and order/
// receipt flows keep the shipped NIP-44 path; this lane is text only by
// design and says so in code.
const DEVICE_SECRET_DOMAIN = new TextEncoder().encode('cipher-dm-test-device/v1');
const appLaneForPk = new Map(); // pk -> Uint8Array(32) domain device secret

// Browser-safe hex: the test-lane path runs in the page where Buffer does not
// exist under Vite.
const hexFromBytes = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function loadAppLane() {
  return import('../lib/protocolTestDm/appLane.js');
}

async function laneDeviceSecret(identity) {
  const cached = appLaneForPk.get(identity.pk);
  if (cached) return cached;
  const sk = identity.sk instanceof Uint8Array ? identity.sk : Uint8Array.from(identity.sk);
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const secret = sha256(new Uint8Array([...DEVICE_SECRET_DOMAIN, ...sk]));
  appLaneForPk.set(identity.pk, secret);
  return secret;
}

// Send one plain text DM through the frozen test-profile wire. Publishes the
// kind-1059 wrap through the SAME pool/relay-list/outbox machinery as the
// legacy path so relay behavior stays comparable; only the wire differs.
// Results mirror sendDM's shape exactly ({success,event,rumorId,...}).
async function sendViaTestProfileLane({ identity, targetDm, messageText, clientId = null }) {
  try {
    assertSecurityContextOwner(identity?.securityFence, identity?.pk);
    const lane = await loadAppLane();
    const { getPublicKey } = await import('nostr-tools/pure');
    const deviceSecret = await laneDeviceSecret(identity);
    const nowSeconds = Math.floor(Date.now() / 1000);
    // Operation id: deterministic from (sender account, recipient, clientId)
    // when a clientId exists so an outbox retry carries identical bytes; else
    // random per profile section 6 retry semantics.
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const opSeed = clientId
      ? new TextEncoder().encode(`cipher-dm-test-op/v1|${identity.pk}|${targetDm}|${clientId}`)
      : crypto.getRandomValues(new Uint8Array(32));
    const opId = hexFromBytes(sha256(opSeed));
    const skBytes = identity.sk instanceof Uint8Array ? identity.sk : Uint8Array.from(identity.sk);
    // Lane R route key (REVIEWER-OPEN derivation shape): HKDF over the SENDER
    // ACCOUNT secret with the peer account pubkey as salt. The receiver
    // derives its own receiving direction identically. No directory (Gate B).
    const routePair = await lane.deriveRouteKeyPair(skBytes, targetDm);
    const operation = lane.buildAppLaneOperation({
      opId,
      sessionId: `lane-${opId.slice(0, 12)}`,
      fromDevicePubkeyHex: getPublicKey(deviceSecret),
      peerAccountPubkeyHex: targetDm,
      bodyText: messageText,
      createdAtSeconds: nowSeconds,
    });
    const built = lane.buildTestProfileWrap({
      operation,
      senderDeviceSecretBytes: deviceSecret,
      routeRecipientSecretOrPubkey: routePair.pubkey,
      sessionId: operation.sessionId ?? `lane-${opId.slice(0, 12)}`,
      authoritySendTimeSeconds: nowSeconds,
      createdAtSeconds: nowSeconds,
    });
    // Publish through the SAME write-ahead outbox + relay pool as every send:
    // identical delivery semantics; only the wrapped event differs.
    let targets = generalRelays.slice();
    let pool = null;
    try {
      pool = await getAuthenticatedPool(identity);
      assertSecurityContextOwner(identity?.securityFence, identity?.pk);
      targets = await relaysForPeer(identity, targetDm);
      assertSecurityContextOwner(identity?.securityFence, identity?.pk);
    } catch (poolError) {
      console.warn('[DM-lane] Offline publish deferred to outbox:', poolError);
    }
    const ephemeral = false; // lane text is a durable message: write-ahead on
    const sent = await publishWriteAhead(built.wrap, targets, () => {
      assertSecurityContextOwner(identity?.securityFence, identity?.pk);
      if (!pool) throw new Error('No relay connection yet.');
      return pool.publish(targets, built.wrap);
    }, { writeAhead: !ephemeral, assertCurrent: () => assertSecurityContextOwner(identity?.securityFence, identity?.pk) });
    assertSecurityContextOwner(identity?.securityFence, identity?.pk);
    if (!sent.queued) return { success: true, event: built.wrap, rumorId: built.wrap.id, results: sent.results, relayCount: sent.okCount, testProfile: true };
    console.warn('[DM-lane] All relays rejected or unreachable:', sent.results);
    return { success: true, queued: true, event: built.wrap, rumorId: built.wrap.id, results: sent.results, relayCount: 0, testProfile: true };
  } catch (error) {
    console.error('[DM-lane] Test-profile send failed:', error);
    return { success: false, error: error?.message || 'Test-profile DM lane failed.' };
  }
}

// Receive one kind-1059 wrap through the frozen test-profile receiver.
// Per-account lazy singleton: route identity + sealed lane store built once
// per account in this session and reused for every wrap. Verdicts:
//   {handled:true}        accepted (and message dispatched to the chat)
//   {rejected:true,...}   frozen order said no; caller must NOT ingest
//   {handled:false}       wrap is not addressed to this account's lane route
//                         -> caller may fall through to the shipped path
const appLaneReceiverForPk = new Map(); // pk -> Promise<{laneStore, receiver, routePair}>

// Route salt discipline: the sender derives the route with (skSender, peer
// account pubkey). The receiving side of a DM to B therefore derives with
// (skB, A account pubkey) - the PEER's key as salt on both ends. The peer's
// account pubkey is read from the incoming wrap: NIP-59 seal recovery needs
// no trust at this stage, and the receiver accepts ONLY wraps whose p tag
// names its own derived route pubkey, so a wrong guess fails closed at step 1.
async function getLaneReceiver(identity, peerAccountPubkeyHex) {
  if (!peerAccountPubkeyHex || !/^[0-9a-f]{64}$/.test(peerAccountPubkeyHex)) {
    throw new Error('The lane receiver needs the peer account pubkey hex.');
  }
  const cacheKey = `${identity.pk}:${peerAccountPubkeyHex}`;
  const cached = appLaneReceiverForPk.get(cacheKey);
  if (cached) return cached;
  const built = (async () => {
    const lane = await loadAppLane();
    const { openDBFor } = await import('../db');
    openDBFor(identity.pk, identity.securityFence);
    const dbInstance = (await import('../db')).db;
    const skBytes = identity.sk instanceof Uint8Array ? identity.sk : Uint8Array.from(identity.sk);
    // Receiving direction: same derivation shape as the send path, but THIS
    // side's secret against the PEER's public key. Symmetric ECDH inside.
    const routePair = await lane.deriveRouteKeyPair(skBytes, peerAccountPubkeyHex);
    const deviceSecret = await laneDeviceSecret(identity);
    const laneStore = lane.createAppLaneStore({ db: dbInstance, vaultKeyBytes: skBytes });
    await laneStore.init();
    const receiver = lane.createAppLaneReceiver({
      laneStore,
      routeSecretBytes: routePair.secret,
      routeRecipientPubkeyHex: routePair.pubkey,
      authorityPubkeyHex: getPublicKey(deviceSecret),
      pinnedRegistryHeadIdHex: LANE_REGISTRY_HEAD_PLACEHOLDER,
      onApplicationEffect: async (effect) => dispatchLaneMessage({ identity, effect }),
    });
    return { lane, laneStore, receiver, routePair, deviceSecret };
  })();
  appLaneReceiverForPk.set(cacheKey, built);
  built.catch(() => appLaneReceiverForPk.delete(cacheKey));
  return built;
}

// Domain placeholder head for the TEST lane: the authority chain is a parked
// lane (Gate A/B); the fixture receiver skips cert/D3 checks when no
// certificate map is provided (profile section 9.1), which is exactly what
// this wiring relies on until certificates ship in a later commit.
const LANE_REGISTRY_HEAD_PLACEHOLDER = 'f'.repeat(64);

async function receiveViaTestProfileLane({ identity, incoming }) {
  try {
    // Peer candidates: every account this device has an open chat with, plus
    // a hex64 p tag if the wrap carries one (lane fixture routes may be
    // pubkey-shaped). Try each as the route salt until ONE decrypts at step 1;
    // nothing about this loop trusts content, and failure for all candidates
    // means "not addressed to any known lane route" -> shipped-path fallback.
    const state = useChatStore.getState();
    const candidates = new Set(Object.keys(state.dms || {}));
    const directTag = incoming?.tags?.find((tag) => tag[0] === 'p')?.[1];
    if (typeof directTag === 'string' && /^[0-9a-f]{64}$/.test(directTag)) candidates.add(directTag);
    if (candidates.size === 0) return { handled: false };
    let lastVerdict = null;
    for (const peerAccountPubkeyHex of candidates) {
      let receiverBundle;
      try {
        receiverBundle = await getLaneReceiver(identity, peerAccountPubkeyHex);
      } catch (constructError) {
        console.error('[DM-lane] Receiver construction failed:', constructError);
        continue;
      }
      try {
        lastVerdict = await receiverBundle.receiver.receive(incoming, { nowSeconds: Math.floor(Date.now() / 1000) });
      } catch (receiveError) {
        lastVerdict = { accepted: false, step: 0, reason: receiveError?.message || 'lane-receive-throw' };
      }
      if (lastVerdict?.accepted) {
        // Dispatch happens inside the receiver's own effect hook, exactly once.
        return { handled: true };
      }
      if (lastVerdict?.step !== 1) break; // real protocol verdict below step 1
    }
    const verdict = lastVerdict;
    if (!verdict) return { handled: false };
    // Step-1 failures mean the wrap was not addressed to any candidate route.
    if (verdict.step === 1 && (verdict.reason === 'route-tag-mismatch' || verdict.reason === 'wrap-decrypt')) {
      return { handled: false };
    }
    return { rejected: true, reason: `${verdict.step ?? '?'}:${verdict.reason ?? 'unknown'}` };
  } catch (error) {
    console.error('[DM-lane] Receive dispatch failed:', error);
    return { rejected: true, reason: `receiver-unavailable:${error?.message ?? String(error)}` };
  }
}

// Dispatch one accepted lane operation into the REAL chat store + database,
// reusing the same persistence shape as the shipped ingestion path so the
// bubble renders identically and survives reload.
async function dispatchLaneMessage({ identity, effect }) {
  try {
    assertSecurityContextOwner(identity?.securityFence, identity?.pk);
    const senderAccount = effect.senderDeviceId; // device pubkey of the sender's seal
    // Resolve the chat by whatever name/profile map says; fall back to raw key.
    const counterparty = effect.counterpartyPubkey ?? senderAccount;
    const data = { type: 'text', message: effect.body ?? '' };
    const nowSec = Math.floor(Date.now() / 1000);
    const newMsg = stampArrival({
      id: `lanemsg-${effect.operationId.slice(0, 24)}`,
      clientId: null,
      isSender: false,
      timestamp: effect.receivedAtSeconds ?? nowSec,
      data,
      pubkey: senderAccount,
      local_timestamp: Date.now(),
      deliveryStatus: undefined,
      replyTo: null,
    });
    const insertion = await saveMessageOnce(counterparty, newMsg);
    if (!['inserted', 'exists'].includes(insertion.status)) {
      console.warn('[DM-lane] Accepted operation was not durably stored:', insertion.status);
      return { dispatched: false, reason: insertion.status };
    }
    useChatStore.getState().setDms((prev) => ({
      ...prev,
      [counterparty]: [...(prev[counterparty] || []), newMsg].sort(sortMessages),
    }));
    return { dispatched: true };
  } catch (error) {
    console.error('[DM-lane] Effect dispatch failed after commit:', error);
    return { dispatched: false, reason: error?.message ?? String(error) };
  }
}

export function useNIP44DM({ identity }) {
  const setDms = useChatStore((s) => s.setDms);
  const setTypingUsers = useChatStore((s) => s.setTypingUsers);

  // Audit F4: storing or cosigning an incoming receipt is only for an order
  // this device tracks that is accepted or further along, and only when every
  // field the order already fixed matches (orderId, coin amount, issued
  // address, the two parties of this chat). A fabricated update can still
  // render as an order_update bubble, but it plants no receipt and harvests
  // no signature.
  const receiptMayBind = useCallback(async (data, counterparty) => {
    try {
      if (!identity?.pk || !data?.orderId || !data?.receipt?.body) return false;
      const messages = await db.messages.where('chatId').equals(counterparty).toArray();
      const record = orderRecordForReceipt(messages, data.orderId, identity.pk);
      if (!record) {
        console.warn('[orders] A receipt arrived for an order this device does not track as accepted. It was not stored or signed.');
        return false;
      }
      const bound = receiptBindsOrder({
        receipt: data.receipt,
        orderId: data.orderId,
        orderCoinAmount: record.coinAmount,
        issuedAddress: record.issuedAddress,
        orderCurrency: record.coinCurrency,
        buyerPubkey: record.isBuyer ? identity.pk : counterparty,
        vendorPubkey: record.isBuyer ? counterparty : identity.pk,
        update: data,
      });
      if (!bound) console.warn('[orders] A receipt did not match the order it arrived under. It was not stored or signed.');
      // N1 fix (round-three re-hack): a buyer's co-signature on a receipt,
      // and on its public view if one rides along, must mean THIS device saw
      // the money with its own watcher — not that the vendor wrote a
      // confirmed receipt over a txid that never happened. The buyer's own
      // check writes seen or confirmed on the order card (security S6);
      // until one landed there, a receipt arriving stores nothing, signs
      // nothing and stays a claim. Their own check is one button away.
      if (bound && record.isBuyer && !deviceWatchedOrderOf(messages, data.orderId)) {
        console.warn('[orders] A receipt arrived before this device checked the payment with its own watcher. It was not stored or signed.');
        return false;
      }
      return bound;
    } catch (error) {
      console.warn('[orders] The receipt could not be checked against the order:', error);
      return false;
    }
  }, [identity]);

  useEffect(() => {
    if (!identity?.sk) return undefined;
    return startOutboxSync(identity);
  }, [identity?.pk, identity?.sk]);

  // SEND A DM
  const sendDM = useCallback(async (recipientPubkey, payload, clientId = null, replyId = null, options = {}) => {
    if (!recipientPubkey || !identity?.sk) return { success: false, error: 'Missing params' };

    // Defensive: trim and cap length
    let targetDm = recipientPubkey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(targetDm)) return { success: false, error: 'That is not a valid public key.' };
    const intent = options?.intent || JSON.stringify({
      recipient: targetDm, clientId, replyId, payload: dmEffectPayload(payload),
    });
    const effectKey = options?.idempotencyKey
      || (clientId ? `dm-client-v1|${identity.pk}|${targetDm}|${clientId}` : null)
      || (payload?.type === 'order_update'
        ? `dm-order-update-v1|${identity.pk}|${targetDm}|${intent}`
        : null);

    // Test-profile DM lane dispatch (flag: Privacy > Test-profile DM lane).
    // Plain text only; everything else keeps the shipped path. No fallback:
    // a failure here is a failed send with its reason.
    if (allowsProtocolTestDm() && payload?.type === 'text' && typeof payload.message === 'string') {
      return sendViaTestProfileLane({ identity, targetDm, messageText: payload.message, clientId, replyId });
    }

    try {
      assertIdentityCurrent(identity);
      const { nip44, nip59 } = await import('nostr-tools');
      assertIdentityCurrent(identity);
      // NIP-59: the label moves inside the sealed payload as `t`, so the
      // relay-visible event carries no sender and no t-tag. Only the
      // recipient's key opens the wrap and reads what kind of message it was.
      const stamped = withBuzzLabel(payload);
      const shared = conversationKey(identity.sk, targetDm);
      // F6: the plaintext body is padded to a fixed size BEFORE encryption so
      // every short-to-medium DM seals into one wire length class.
      const encrypted = nip44.v2.encrypt(padRumorContent(JSON.stringify(stamped)), shared);
      const rumor = nip59.createRumor({
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: rumorTags({ recipient: targetDm, clientId, replyId }),
        content: encrypted,
      }, identity.sk);
      const { wrap } = sealAndWrap(rumor, { senderSk: identity.sk, recipientPubkey: targetDm });

      let targets = generalRelays.slice();
      let pool = null;
      try {
        pool = await getAuthenticatedPool(identity);
        assertIdentityCurrent(identity);
        publishOwnRelayList(identity).catch(() => {});
        targets = await relaysForPeer(identity, targetDm);
        assertIdentityCurrent(identity);
      } catch (publishError) {
        assertIdentityCurrent(identity);
        console.warn('[DM] Offline publish deferred to outbox:', publishError);
      }
      // Write-ahead (see publishWriteAhead): the signed event is in the outbox
      // before any relay is tried, so a close between sign and publish cannot
      // lose it. Calls and read marks are ephemeral and keep the old order.
      const ephemeral = payload?.type === 'call' || payload?.type === 'read';
      const gatewayKey = activeGatewayPubkey();
      // A buzzable DM also wraps a copy of its seal to the push gateway's
      // key, so the box still learns something arrived without reading any
      // tag off the wire. Silent signals wrap nothing. The box reads only its
      // own layer; the recipient's seal inside stays sealed.
      if (!effectKey && gatewayKey && pool && buzzLabelFor(payload)) {
        assertIdentityCurrent(identity);
        const gatewayWrap = wrapForGateway({
          senderSk: identity.sk,
          recipientPubkey: targetDm,
          gatewayPubkey: gatewayKey,
          payload,
        });
        if (gatewayWrap) {
          try { Promise.allSettled(pool.publish(targets, gatewayWrap)).catch(() => {}); } catch { /* push is best effort */ }
        }
      }
      if (effectKey) {
        // A countersign or other application effect reserves one signed event
        // and its outbox row atomically. A second tab or crash retry reuses
        // that exact event id; it never constructs a second logical send.
        assertIdentityCurrent(identity);
        const reservation = await reserveMessageEffect({
          owner: identity.pk,
          idempotencyKey: effectKey,
          intent,
          event: wrap,
          relays: targets,
        });
        assertIdentityCurrent(identity);
        if (reservation.status === 'sent') {
          return { success: true, duplicate: true, eventId: reservation.eventId, relayCount: 0 };
        }
        if (reservation.created && gatewayKey && pool && buzzLabelFor(payload)) {
          assertIdentityCurrent(identity);
          const gatewayWrap = wrapForGateway({
            senderSk: identity.sk,
            recipientPubkey: targetDm,
            gatewayPubkey: gatewayKey,
            payload,
          });
          if (gatewayWrap) {
            try { Promise.allSettled(pool.publish(reservation.relays.length ? reservation.relays : targets, gatewayWrap)).catch(() => {}); } catch { /* push is best effort */ }
          }
        }
        const effectEvent = reservation.event;
        const effectRelays = reservation.relays.length ? reservation.relays : targets;
        assertIdentityCurrent(identity);
        const results = pool
          ? await Promise.allSettled(pool.publish(effectRelays, effectEvent))
          : [];
        assertIdentityCurrent(identity);
        const okCount = results.filter((result) => result.status === 'fulfilled').length;
        if (okCount > 0) {
          try { await completeMessageEffect({ owner: identity.pk, eventId: reservation.eventId }); }
          catch (error) { console.warn('[DM] A delivered effect remains queued for idempotent recovery:', error); }
          return { success: true, event: effectEvent, rumorId: rumor.id, results, relayCount: okCount };
        }
        return { success: true, queued: true, event: effectEvent, rumorId: rumor.id, results, relayCount: 0 };
      }
      assertIdentityCurrent(identity);
      const sent = await publishWriteAhead(wrap, targets, () => {
        assertIdentityCurrent(identity);
        if (!pool) throw new Error('No relay connection yet.');
        return pool.publish(targets, wrap);
      }, { writeAhead: !ephemeral, assertCurrent: () => assertIdentityCurrent(identity) });
      assertIdentityCurrent(identity);
      if (!sent.queued) return { success: true, event: wrap, rumorId: rumor.id, results: sent.results, relayCount: sent.okCount };
      console.warn('[DM] All relays rejected:', sent.results);
      return { success: true, queued: true, event: wrap, rumorId: rumor.id, results: sent.results, relayCount: 0 };
    } catch (err) {
      console.error('[useNIP44DM] Send failed:', err);
      return { success: false, error: err.message };
    }
  }, [identity]);

  // SEND TYPING INDICATOR
  //
  // Was a bare kind-4 signed by the sender, so the one signal that fires on
  // every keystroke handed the message relay the sender's key and an exact
  // timestamp while every actual message stayed anonymous behind a wrap. A
  // relay could line the two up and attribute a thread from a single typing
  // tick. It now travels as a wrap like everything else: no sender on the
  // wire, and the outer created_at is backdated up to two days.
  //
  // The ingest already handles a wrapped event by unwrapping the rumor first,
  // so `event.pubkey` and `event.created_at` downstream are the real ones and
  // the ten-second freshness window below still means what it says.
  const sendTypingIndicator = useCallback(async (recipientPubkey) => {
    if (!recipientPubkey || !identity?.sk || !/^[0-9a-f]{64}$/i.test(recipientPubkey) || !allowsTyping()) return;
    try {
      assertIdentityCurrent(identity);
      const { nip44, nip59 } = await import('nostr-tools');
      assertIdentityCurrent(identity);
      const pool = await getAuthenticatedPool(identity);
      assertIdentityCurrent(identity);
      const targets = await relaysForPeer(identity, recipientPubkey);
      assertIdentityCurrent(identity);
      const targetDm = recipientPubkey.trim().toLowerCase();
      // Same two layers sendDM uses: the payload is encrypted to the pair, and
      // the rumor carries that ciphertext. Ingest decrypts event.content, so a
      // plaintext body here would parse as a failed decrypt and be dropped.
      const shared = conversationKey(identity.sk, targetDm);
      // F6: typing rides the same fixed-size class as messages — one length
      // for both so cadence cannot be told from content on the wire.
      const encrypted = nip44.v2.encrypt(padRumorContent(JSON.stringify({ type: 'typing' })), shared);
      const rumor = nip59.createRumor({
        kind: 4, // Use kind 4 so strict relays accept it
        created_at: Math.floor(Date.now() / 1000),
        tags: rumorTags({ recipient: targetDm }),
        content: encrypted,
      }, identity.sk);
      const { wrap } = sealAndWrap(rumor, { senderSk: identity.sk, recipientPubkey: targetDm });
      assertIdentityCurrent(identity);
      const results = await Promise.allSettled(pool.publish(targets.length ? targets : generalRelays, wrap));
      assertIdentityCurrent(identity);
      if (results.every((result) => result.status === 'rejected')) {
        console.warn('[DM] Typing indicator was rejected by all relays:', results);
      }
    } catch (error) {
      console.warn('[DM] Could not send typing indicator:', error);
    }
  }, [identity]);

  // SUBSCRIBE TO INCOMING + OUTGOING DMs
  const subscribeToDMs = useCallback((since) => {
    let subs = [];
    const mounted = { current: true };

    const setup = async () => {
      const pool = await getAuthenticatedPool(identity);
      assertIdentityCurrent(identity);
      if (!mounted.current) return;
      publishOwnRelayList(identity).catch(() => {});
      const dmFilters = dmSubscriptionFilters(identity.pk, since);
      for (const filter of dmFilters) {
        if (!mounted.current) break;
        // The serving relay is the safety number's honest input (drill round
        // three): a key first seen on a different relay set must derive a
        // different code, or the relay-swap warning the derivation promises
        // is dead. The library hands the relay to receivedEvent just before
        // the event reaches onevent, so a per-id note is the whole wiring —
        // no pool-wide relay tracking, no second subscription, dedup kept.
        // A duplicate that loses the relay race leaves an entry nobody
        // reads; the map clears itself long before that could matter.
        const servingRelay = new Map();
        const sub = pool.subscribe(generalRelays, filter, {
          receivedEvent: (relay, id) => {
            if (servingRelay.size > 500) servingRelay.clear();
            servingRelay.set(id, relay.url);
          },
          onevent: async (incoming) => {
            if (!mounted.current) return;
            try {
              assertIdentityCurrent(identity);
              // Test-profile DM lane receive (flag: Privacy > Test-profile DM
              // lane): a kind-1059 wrap when the flag is on goes through the
              // frozen receiver FIRST. Fail closed: any rejection logs the
              // reason and returns with NO effect and NO fallback ingest of
              // the event by the legacy path. The legacy openDmTransportEvent
              // below stays untouched for the flag-off case.
              if (incoming?.kind === GIFT_WRAP_KIND && allowsProtocolTestDm()) {
                const laneVerdict = await receiveViaTestProfileLane({ identity, incoming });
                if (laneVerdict.handled) return;
                if (laneVerdict.rejected) {
                  console.warn('[DM-lane] Wrap rejected by test-profile receiver:', laneVerdict.reason);
                  return;
                }
                // handled=false, rejected=false -> not a lane-addressed wrap:
                // fall through to the shipped path (ordinary DMs stay working).
              }
              const { nip44 } = await import('nostr-tools');
              assertIdentityCurrent(identity);
              // NIP-59 transition: a wrapped DM (kind 1059) opens here before
              // anything downstream reads it; a legacy bare kind-4 keeps its
              // old shape and goes through unchanged.
              const event = openDmTransportEvent(incoming, identity.sk);
              if (!event) return;
              const isSender = event.pubkey === identity.pk;
              const counterparty = isSender ? event.tags.find(t => t[0] === 'p')?.[1] : event.pubkey;
              if (!counterparty) return;
              // Safety numbers: first time this key speaks to us, freeze
              // where we actually saw it — the relay that served this event
              // when the caller knows it, the configured set otherwise
              // (the history arm has no per-event attribution). Fire-and-
              // forget — never blocks ingestion.
              const serving = servingRelay.get(event.id);
              servingRelay.delete(event.id);
              noteFirstSeen(counterparty, serving ? [serving] : null, undefined, identity.securityFence).catch(() => {});
              // Audit H8: drop messages from blocked users at ingestion
              const blocked = useChatStore.getState().blockedUsers || [];
              if (blocked.includes(counterparty)) return;
              const shared = conversationKey(identity.sk, counterparty);
              let text;
              try { text = nip44.v2.decrypt(event.content, shared); }
              catch (e) { return; }
              let data = {};
              try { data = unpadRumorBody(JSON.parse(text)); } catch (e) { data = { type: 'text', message: text }; }

              // The inner rumor id is canonical across live and history
              // delivery, even if a sender or relay gives it a fresh outer
              // wrap. Never rerun application actions for a stored or deleted
              // event. Receipt updates remain eligible for their explicit
              // durable countersign retry path.
              const alreadyStored = !isSender && !!(await db.messages.get(event.id));
              assertIdentityCurrent(identity);
              const tombstoned = !isSender && !!(await db.tombstones.get(event.id));
              assertIdentityCurrent(identity);
              if (tombstoned) return;
              if (alreadyStored && !(data.type === 'order_update' && data.receipt)) return;

              if (data.type === 'call') {
                if (!isSender) {
                  const { handleCallSignal } = await import('../lib/voiceCall');
                  // Only someone we have written to gets the refusal; a stranger's offer gets silence.
                  const thread = useChatStore.getState().dms?.[counterparty] || [];
                  const known = thread.some((message) => message?.isSender);
                  await handleCallSignal({ data, from: counterparty, known, eventId: event.id, createdAt: event.created_at });
                  assertIdentityCurrent(identity);
                }
                return;
              }
              if (data.type === 'typing') {
                const age = (Date.now() / 1000) - event.created_at;
                if (age < 10 && event.pubkey !== identity.pk) {
                  setTypingUsers(prev => ({ ...prev, [counterparty]: Date.now() }));
                }
                return;
              }
              if (data.type === 'read') {
                // Only the peer's receipt means "they read it". Our own receipt,
                // echoed back from the relay, says nothing about our messages.
                if (isSender) return;
                const upTo = receiptTime(data, event.created_at);
                // Written to the database first: the history fetch re-saves
                // our messages as 'sent', and a tick held only in memory died
                // on reload. Scoped to messages at or before the receipt.
                await markSentMessagesRead(counterparty, upTo);
                assertIdentityCurrent(identity);
                setDms(prev => {
                  const msgs = prev[counterparty] || [];
                  return { ...prev, [counterparty]: msgs.map(m => (m.isSender && Number(m.timestamp) <= upTo && m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed' ? { ...m, read: true, deliveryStatus: 'read' } : m)) };
                });
                return;
              }
              // Audit H9, moved ahead of the engines (drill round three): an
              // expired message is dead on arrival. The drop used to sit
              // AFTER this block, so a key bundle that aged out in flight
              // still installed, and a stale receipt still countersigned.
              if (dmExpired(data)) {
                console.log('[DM] Dropping expired message', { from: counterparty.slice(0, 8), expires_at: data.expires_at });
                return;
              }
              // The stamp the row will carry is the one the roster promised:
              // clamped to the longest choice the timer offers, and a stamp
              // that is not a future whole-seconds integer carries no
              // sentence, so the saved row honors nothing from it. (drill
              // round residual — the receiver never clamps sender-written
              // stamps)
              if (data.expires_at != null) {
                data = { ...data, expires_at: clampedExpiresAt(data.expires_at) ?? undefined };
              }
              if (dmControlAction(data) === 'gkey') {
                if (!identity.securityFence) return;
                openDBFor(identity.pk, identity.securityFence);
                const installed = await installMemberGroupKey(data, event.pubkey, identity.securityFence);
                assertIdentityCurrent(identity);
                if (!installed) console.error('[group-key] A key message arrived and was not installed.');
                return;
              }
              if (data.type === 'pin') return;
              let acceptedReceipt = null;
              if (data.type === 'order_update' && data.receipt && !isSender) {
                // The mark says this device accepted this receipt, so the wire
                // may not carry it in. Stripped before the gate is asked, and
                // written back only if the gate says yes.
                data = stripArrivingReceiptMark(data);
                if (await receiptMayBind(data, counterparty)) {
                  assertIdentityCurrent(identity);
                  const accepted = acceptPayment(data, identity.sk);
                  if (accepted) {
                    acceptedReceipt = accepted;
                    const boundReceipt = { ...accepted.receipt, bound: true };
                    data = { ...data, receipt: boundReceipt, ...(accepted.published ? { published: accepted.published } : {}) };
                  }
                }
              }

              const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
              const clientId = event.tags.find(t => t[0] === 'client')?.[1];
              const newMsg = stampArrival({
                id: event.id, clientId, isSender,
                timestamp: event.created_at, data,
                pubkey: event.pubkey,
                local_timestamp: Date.now(),
                deliveryStatus: isSender ? 'sent' : undefined,
                replyTo: replyTag ? replyTag[1] : null
              });
              const insertion = await saveMessageOnce(counterparty, newMsg);
              assertIdentityCurrent(identity);
              if (insertion.status === 'tombstoned') return;
              if (!['inserted', 'exists'].includes(insertion.status)) {
                console.warn('[DM] The event was not durably stored; its application effects were deferred.', insertion.status);
                return;
              }
              // The durable message wins before order side effects. Retries
              // can therefore recover a countersign from the same event, and
              // a locked vault or failed write never triggers an unjournaled
              // payment acknowledgement.
              if (acceptedReceipt) {
                if (!scopedSetVerified(`receipt_${data.orderId}`, data.receipt)
                  || !scopedSetVerified(`bound_receipt_${data.orderId}`, acceptedReceipt.receipt.hash)) {
                  console.warn('[orders] Accepted receipt state was not durable; the countersign was deferred.');
                  return;
                }
                if (acceptedReceipt.published) rememberPublicView(acceptedReceipt.published);
                sendCountersign(sendDM, counterparty, data.orderId, acceptedReceipt);
              }
              if (isSender && clientId) {
                const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
                assertIdentityCurrent(identity);
                if (optimisticMessage?.chatId === counterparty && optimisticMessage.isSender && optimisticMessage.id !== event.id) {
                  await db.messages.delete(optimisticMessage.id);
                }
              }
              // Read before the save: whether this id is already stored, was
              // deleted here, and where the chat's read marker stands.
              const lastRead = isSender ? 0 : ((await db.chatReads.get(counterparty))?.lastRead || 0);
              assertIdentityCurrent(identity);
              await saveMessage(counterparty, newMsg);
              assertIdentityCurrent(identity);
              if (!isSender && insertion.status === 'inserted') {
                const state = useChatStore.getState();
                const chatOpen = state.activeDm === counterparty;
                if (countsAsNewUnread({ alreadyStored, tombstoned, isSender, chatOpen, timestamp: event.created_at, lastRead })) {
                  state.setUnreadCounts(prev => ({ ...prev, [counterparty]: (prev[counterparty] || 0) + 1 }));
                } else if (chatOpen && !tombstoned) {
                  // Arriving into the chat on screen is reading it: the marker
                  // moves, or the message counts as unread after a reload.
                  markChatRead(counterparty, Math.max(Math.floor(Date.now() / 1000), event.created_at));
                }
              }
              if (!isSender && insertion.status === 'inserted' && data.type !== 'typing' && data.type !== 'read' && !shouldSuppress(counterparty)) {
                // S11: the counterparty is the throttle key. Ingestion above
                // is untouched — the message has already landed and marked unread.
                showNotification(data.type === 'order_request' ? 'order' : 'message', counterparty);
              }
              setDms(prev => {
                const chatMsgs = prev[counterparty] || [];
                const filtered = isSender && clientId
                  ? chatMsgs.filter(m => m.clientId !== clientId)
                  : chatMsgs;
                if (filtered.some((message) => message.id === event.id)) return prev;
                return { ...prev, [counterparty]: [...filtered, newMsg].sort(sortMessages) };
              });
            } catch (e) { console.error('Live DM error:', e); }
          }
        });
        if (mounted.current) subs.push(sub);
        else sub.close();
      }
    };
    setup().catch((error) => {
      if (mounted.current) console.error('[DM] Failed to start subscriptions:', error);
    });
    return () => {
      mounted.current = false;
      subs.forEach(s => { try { s.close(); } catch (e) {} });
    };
  }, [identity, setDms, setTypingUsers, sendDM, receiptMayBind]);

  // FULL FETCH OF DM HISTORY
  const fetchDMs = useCallback(async () => {
    assertIdentityCurrent(identity);
    const pool = await getAuthenticatedPool(identity);
    assertIdentityCurrent(identity);
    const { nip44 } = await import('nostr-tools');
    assertIdentityCurrent(identity);
    const [sentDms, recvDms] = await Promise.all([
      queryAllPages(pool, generalRelays, { kinds: [4], authors: [identity.pk] }),
      queryAllPages(pool, generalRelays, { kinds: [4, GIFT_WRAP_KIND], '#p': [identity.pk] })
    ]);
    assertIdentityCurrent(identity);
    // NIP-59 transition: wraps open into their rumors before the merge, so
    // every branch below reads one shape. A bare kind-4 passes through as its
    // own envelope, so an old message still opens.
    const openedInbox = [];
    for (const incoming of [...sentDms, ...recvDms]) {
      const opened = openDmTransportEvent(incoming, identity.sk);
      if (opened) openedInbox.push(opened);
    }
    const allDms = Array.from(new Map(openedInbox.map(ev => [ev.id, ev])).values());
    const readUpTo = new Map();
    for (const ev of allDms) {
      try {
        assertIdentityCurrent(identity);
        const isSender = ev.pubkey === identity.pk;
        const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
        if (!counterparty) continue;
        const existingMessage = await db.messages.get(ev.id);
        assertIdentityCurrent(identity);
        const deletedMessage = await db.tombstones.get(ev.id);
        assertIdentityCurrent(identity);
        if (deletedMessage) continue;
        // Safety numbers: same first-seen freeze on the history path. A
        // merged history fetch has no per-event attribution, so the honest
        // first-seen answer here is the set the query itself ran on.
        noteFirstSeen(counterparty, null, undefined, identity.securityFence).catch(() => {});
        const blocked = useChatStore.getState().blockedUsers || [];
        if (blocked.includes(counterparty)) continue;
        const shared = conversationKey(identity.sk, counterparty);
        let text;
        try { text = nip44.v2.decrypt(ev.content, shared); }
        catch (e) { continue; }
        let data = {};
        try { data = JSON.parse(text); } catch (e) { data = { type: 'text', message: text }; }
        if (existingMessage && !(data.type === 'order_update' && data.receipt)) continue;
        // Audit H9, moved ahead of the engines (drill round three): same
        // ordering as the live arm — an expired message runs no key install
        // and countersigns no receipt, and it saves nowhere.
        if (dmExpired(data)) continue;
        if (dmControlAction(data) === 'gkey') {
          if (!identity.securityFence) continue;
          openDBFor(identity.pk, identity.securityFence);
          const installed = await installMemberGroupKey(data, ev.pubkey, identity.securityFence);
          assertIdentityCurrent(identity);
          if (!installed) console.error('[group-key] A key message arrived and was not installed.');
          continue;
        }
        if (data.type === 'read' && !isSender) {
          // Receipts that came in while the app was closed: keep the newest
          // per peer and apply it after the loop.
          const upTo = receiptTime(data, ev.created_at);
          if (Number.isFinite(upTo) && upTo > (readUpTo.get(counterparty) ?? 0)) readUpTo.set(counterparty, upTo);
          continue;
        }
        if (data.type === 'typing' || data.type === 'read' || data.type === 'pin' || data.type === 'call') {
          continue;
        }
        let acceptedReceipt = null;
        if (!isSender && data.type === 'order_update' && data.receipt) {
          // Same strip as the live path, for the same reason: the copy that
          // comes back through history is the peer's text too.
          data = stripArrivingReceiptMark(data);
          if (await receiptMayBind(data, counterparty)) {
            assertIdentityCurrent(identity);
            const accepted = acceptPayment(data, identity.sk);
            if (accepted) {
              acceptedReceipt = accepted;
              const boundReceipt = { ...accepted.receipt, bound: true };
              data = { ...data, receipt: boundReceipt, ...(accepted.published ? { published: accepted.published } : {}) };
            }
          }
        }
        const replyTag = ev.tags.find(t => t[0] === 'e' && t[3] === 'reply');
        const clientId = ev.tags.find(t => t[0] === 'client')?.[1];
        if (isSender && clientId) {
          const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
          assertIdentityCurrent(identity);
          if (optimisticMessage?.chatId === counterparty && optimisticMessage.isSender && optimisticMessage.id !== ev.id) {
            await db.messages.delete(optimisticMessage.id);
          }
        }
        const historyMessage = {
          id: ev.id, clientId, isSender,
          timestamp: ev.created_at, data,
          pubkey: ev.pubkey,
          replyTo: replyTag ? replyTag[1] : null,
          deliveryStatus: isSender ? 'sent' : undefined,
          isGroup: false
        };
        const insertion = await saveMessageOnce(counterparty, historyMessage);
        assertIdentityCurrent(identity);
        if (insertion.status === 'tombstoned') continue;
        if (!['inserted', 'exists'].includes(insertion.status)) continue;
        if (acceptedReceipt) {
          if (!scopedSetVerified(`receipt_${data.orderId}`, data.receipt)
            || !scopedSetVerified(`bound_receipt_${data.orderId}`, acceptedReceipt.receipt.hash)) {
            console.warn('[orders] Accepted receipt state was not durable; the countersign was deferred.');
            continue;
          }
          if (acceptedReceipt.published) rememberPublicView(acceptedReceipt.published);
          sendCountersign(sendDM, counterparty, data.orderId, acceptedReceipt);
        }
        await saveMessage(counterparty, historyMessage);
        assertIdentityCurrent(identity);
      } catch (error) {
        if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
        console.error('[DM] Could not save a message:', error);
      }
    }
    assertIdentityCurrent(identity);
    for (const [peer, upTo] of readUpTo) {
      assertIdentityCurrent(identity);
      await markSentMessagesRead(peer, upTo);
      assertIdentityCurrent(identity);
    }
    const counterparties = new Set();
    for (const ev of allDms) {
      const isSender = ev.pubkey === identity.pk;
      const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
      if (counterparty) counterparties.add(counterparty);
    }
    // The drill (round three, 4d) caught commit 9b07acd dropping this
    // return: the hook then resolves undefined and every app load throws
    // reading .length of it in useChatBootstrap — profile loading dies
    // with it.
    return [...counterparties];
  }, [identity, sendDM, receiptMayBind]);

  return { sendDM, sendTypingIndicator, subscribeToDMs, fetchDMs };
}
