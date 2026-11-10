import { useCallback, useState } from 'react';
import { getAuthenticatedPool } from '../lib/pool';
import { profileReadRelays, queryWithTimeout, reputationRelays } from '../lib/relays';
import { enqueueNostrEvent } from '../lib/outbox';
import { shortNpub } from '../lib/npub';

// Defense layer cache — profile timestamps keyed by pubkey
// Prevents re-fetching the same profile on every modal open
import { scopedGet, scopedSet } from '../lib/storage';
import { averageRating, clampRating, profileAgeDays, receiptBindingOf, vouchCoversTrade } from '../lib/reputation';
import { DISPUTE_KIND, markOwnRider, riderRefusal } from '../lib/disputes';
import { assertSecurityContextOwner } from '../lib/securityContextFence';
const PROFILE_CACHE_KEY = 'rep_profile_cache';
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function loadProfileCache() {
  try { return scopedGet(PROFILE_CACHE_KEY, {}); } catch { return {}; }
}

function saveProfileCache(cache) {
  try { scopedSet(PROFILE_CACHE_KEY, cache); } catch {}
}

export function useReputation({ identity }) {
  const [reputation, setReputation] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchReputation = useCallback(async (targetPubkey) => {
    if (!targetPubkey) return;
    try {
      assertSecurityContextOwner(identity?.securityFence, identity?.pk);
      setLoading(true);
      const pool = await getAuthenticatedPool(identity);
      assertSecurityContextOwner(identity.securityFence, identity.pk);

      // 1. Fetch raw vouches + reviews
      const [vouchEvents, reviews] = await Promise.all([
        queryWithTimeout(pool, reputationRelays, { kinds: [10004], '#p': [targetPubkey] }, 3000),
        queryWithTimeout(pool, reputationRelays, { kinds: [10005], '#p': [targetPubkey] }, 3000)
      ]);
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      // S8: a vouch counts only when it names the receipt hash of a trade,
      // and the trade it names involves both the target and the author —
      // the role tags the author's own signature vouches for. The hash is
      // all the event carries; the receipt stays private.
      const rawVouches = vouchEvents.filter((event) => (
        event.tags.some((tag) => tag[0] === 'p' && tag[1] === targetPubkey) &&
        event.tags.some((tag) => tag[0] === 'vouch' && tag[1] === 'true') &&
        !!receiptBindingOf(event) &&
        vouchCoversTrade(event, targetPubkey)
      ));

      // 2. Defense Layer 1: reject self-vouches + duplicate vouches
      const seenVouchers = new Set();
      const vouchesAfterSelf = rawVouches.filter((ev) => {
        if (ev.pubkey === targetPubkey) return false; // self-vouch
        if (seenVouchers.has(ev.pubkey)) return false; // duplicate
        seenVouchers.add(ev.pubkey);
        return true;
      });

      // 3. Defense Layer 3: check voucher profile age
      const cache = loadProfileCache();
      const now = Date.now();

      // Find which vouchers need profile fetch (not cached, or cache expired)
      const toFetch = vouchesAfterSelf
        .map((v) => v.pubkey)
        .filter((pk) => {
          const c = cache[pk];
          return !c || (now - c.fetchedAt) > PROFILE_CACHE_TTL;
        });

      let freshProfiles = [];
      if (toFetch.length > 0) {
        try {
          freshProfiles = await queryWithTimeout(
            pool,
            profileReadRelays,
            { kinds: [0], authors: toFetch },
            3000
          );
          assertSecurityContextOwner(identity.securityFence, identity.pk);
        } catch (error) {
          if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
        }
      }

      // Merge into cache
      for (const ev of freshProfiles) {
        let meta = {};
        try { meta = JSON.parse(ev.content); } catch {}
        cache[ev.pubkey] = {
          createdAt: ev.created_at,          // profile's last update time
          fetchedAt: now,
          name: meta.display_name || meta.name || shortNpub(ev.pubkey),
          picture: meta.picture || null,
        };
      }
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      saveProfileCache(cache);

      // 4. Build voucher display objects. Defense Layer 3 used to drop a
      // vouch whose author's profile was younger than a week, reading the
      // kind-0 `created_at` as account age. That stamp is the publisher's own
      // claim and is rewritten on every profile edit, so it is not proof of
      // age; the count no longer depends on it. Every receipt-bound, non-self,
      // deduped vouch counts; the apparent age rides along as a label only.
      const nowSec = Math.floor(now / 1000);
      const vouchInfos = vouchesAfterSelf.map((ev) => {
        const profile = cache[ev.pubkey];
        return {
          pubkey: ev.pubkey,
          name: profile?.name || shortNpub(ev.pubkey),
          picture: profile?.picture || null,
          // Not verified: see profileAgeDays. Nothing independently proves it.
          ageDays: profileAgeDays(profile?.createdAt, nowSec),
          ageVerified: false,
          reason: null,
        };
      });

      // 5. Reviews (also self-review protected)
      // S8: a review is only a rating about a trade, and an average cannot
      // go below zero. A negative score pulls the vendor toward 0, no further.
      const validReviews = reviews.filter((ev) => ev.pubkey !== targetPubkey);
      const avgRating = averageRating(validReviews.map(
        (ev) => ev.tags.find((t) => t[0] === 'rating')?.[1]
      ));

      const hasVouched = vouchesAfterSelf.some((ev) => ev.pubkey === identity.pk);

      assertSecurityContextOwner(identity.securityFence, identity.pk);
      setReputation({
        // Every receipt-bound vouch counts: no publisher timestamp gate.
        vouchCount: vouchInfos.length,
        rawVouchCount: rawVouches.length,
        filteredCount: 0,
        vouchList: vouchInfos,
        filteredList: [],
        reviewCount: validReviews.length,
        avgRating,
        hasVouched,
        recentReviews: validReviews.slice(0, 3).map((ev) => ({
          pubkey: ev.pubkey,
          rating: clampRating(ev.tags.find((t) => t[0] === 'rating')?.[1]),
          text: ev.content,
        })),
      });
    } catch (e) {
      if (e?.code === 'SECURITY_CONTEXT_EXPIRED') return;
      console.error('[useReputation] fetch failed:', e);
    } finally {
      try {
        assertSecurityContextOwner(identity?.securityFence, identity?.pk);
        setLoading(false);
      } catch {}
    }
  }, [identity]);

  // S8: a vouch is signed by its author (the Nostr event carries the signature)
  // and names the receipt hash of the trade it vouches for. No receipt hash,
  // no vouch — anyone can claim trust for a stranger; only a completed trade
  // earns it. The hash is all that is published; the receipt stays private.
  // trade names the vendor and buyer of the trade this device took part in,
  // under this signature — so the vouch cannot be transplanted onto anyone
  // else. (security S8)
  const sendVouch = useCallback(async (targetPubkey, receiptHash, trade = null) => {
    // Defense Layer 1: refuse to vouch yourself
    if (!targetPubkey || !identity?.pk || !identity?.sk) {
      return { success: false, error: 'Unlock your account before vouching.' };
    }
    if (targetPubkey === identity.pk) {
      return { success: false, error: 'Cannot vouch for yourself' };
    }
    const binding = receiptBindingOf({ tags: [['receipt', receiptHash]] });
    if (!binding) {
      return { success: false, error: 'A vouch needs the receipt of a completed trade.' };
    }
    const vendor = String(trade?.vendor || '').toLowerCase();
    const buyer = String(trade?.buyer || '').toLowerCase();
    if (!vendor || !buyer || vendor === buyer
      || ![targetPubkey.toLowerCase(), identity.pk.toLowerCase()].every((party) => party === vendor || party === buyer)) {
      return { success: false, error: 'A vouch names the trade this device took part in.' };
    }

    let event;
    try {
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const { finalizeEvent } = await import('nostr-tools');
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      event = finalizeEvent({
        kind: 10004,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', targetPubkey], ['vouch', 'true'], ['receipt', binding],
          ['trade_vendor', vendor], ['trade_buyer', buyer],
        ],
        content: 'Vouched via Cipher',
      }, identity.sk);

      const pool = await getAuthenticatedPool(identity);
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      // N2: a vouch is a public trade event — the two pubkeys and the
      // receipt hash. It rides the reputation relays (the storefront's
      // group relays), never the message relay, so the DM relay's operator
      // cannot join trade events to message flow.
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const results = await Promise.allSettled(pool.publish(reputationRelays, event));
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      if (!results.some((result) => result.status === 'fulfilled')) {
        await enqueueNostrEvent(event, null, identity.securityFence);
        assertSecurityContextOwner(identity.securityFence, identity.pk);
        return { success: true, queued: true };
      }
      // Refetch to recalculate trust (invalid vouches still don't count)
      await fetchReputation(targetPubkey);
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      return { success: true };
    } catch (e) {
      if (e?.code === 'SECURITY_CONTEXT_EXPIRED') return { success: false, error: 'The account context expired before the vouch completed.' };
      if (event) {
        try {
          assertSecurityContextOwner(identity?.securityFence, identity?.pk);
          await enqueueNostrEvent(event, null, identity.securityFence);
          return { success: true, queued: true };
        } catch (queueError) {
          console.error('[useReputation] Could not queue vouch:', queueError);
        }
      }
      return { success: false, error: e.message };
    }
  }, [identity, fetchReputation]);

  // Same rule as a vouch: a review names the receipt hash of the trade, and
  // the score it carries stays inside 0..5. (security S8)
  const sendReview = useCallback(async (targetPubkey, rating, text, receiptHash) => {
    if (!identity?.pk || !identity?.sk) return { success: false, error: 'Unlock your account before reviewing.' };
    if (targetPubkey === identity.pk) {
      return { success: false, error: 'Cannot review yourself' };
    }
    const binding = receiptBindingOf({ tags: [['receipt', receiptHash]] });
    if (!binding) {
      return { success: false, error: 'A review needs the receipt of a completed trade.' };
    }
    try {
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const { finalizeEvent } = await import('nostr-tools');
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const pool = await getAuthenticatedPool(identity);
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const ev = finalizeEvent({
        kind: 10005,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', targetPubkey], ['rating', String(clampRating(rating))], ['receipt', binding]],
        content: text,
      }, identity.sk);
      // The review rides the same queue as a vouch or a rider: a publish
      // hiccup must not lose the event. It is signed, so the outbox
      // re-attempts it; a locally-saved-only review that nobody re-sends
      // is a review that never lands. N2: the review rides the reputation
      // relays, never the message relay.
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const results = await Promise.allSettled(pool.publish(reputationRelays, ev));
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      if (!results.some((result) => result.status === 'fulfilled')) {
        await enqueueNostrEvent(ev, null, identity.securityFence);
        assertSecurityContextOwner(identity.securityFence, identity.pk);
        await fetchReputation(targetPubkey);
        return { success: true, queued: true };
      }
      await fetchReputation(targetPubkey);
      return { success: true };
    } catch (e) {
      if (e?.code === 'SECURITY_CONTEXT_EXPIRED') return { success: false, error: 'The account context expired before the review completed.' };
      return { success: false, error: e.message };
    }
  }, [identity, fetchReputation]);

  // A dispute rider: the vendor's flag or rebuttal, the buyer's supplement —
  // one word each per (receipt, review), and the refusal lives in
  // disputes.js so the compose screen refuses the same words the publisher
  // does. The event is signed only after the refusal passes; the moment it
  // is signed, its word is spent on the local record, publish hiccup or not.
  const sendRider = useCallback(async ({ vendor, receiptHash, review, rider, text }) => {
    if (!identity?.pk || !identity?.sk) return { success: false, error: 'Unlock your account before posting a dispute response.' };
    const refusal = riderRefusal({ author: identity?.pk, vendor, receiptHash, review, rider, text });
    if (refusal) return { success: false, error: refusal };
    let event;
    try {
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const { finalizeEvent } = await import('nostr-tools');
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const binding = receiptBindingOf({ tags: [['receipt', receiptHash]] });
      event = finalizeEvent({
        kind: DISPUTE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', String(vendor).toLowerCase()], ['receipt', binding], ['review', String(review).toLowerCase()], ['rider', rider]],
        content: String(text).trim(),
      }, identity.sk);
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      markOwnRider(vendor, binding, review, rider, event.id);
      const pool = await getAuthenticatedPool(identity);
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      // N2: a rider is a public dispute event. Reputation relays, never
      // the message relay.
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      const results = await Promise.allSettled(pool.publish(reputationRelays, event));
      assertSecurityContextOwner(identity.securityFence, identity.pk);
      if (!results.some((result) => result.status === 'fulfilled')) {
        await enqueueNostrEvent(event, null, identity.securityFence);
        assertSecurityContextOwner(identity.securityFence, identity.pk);
        return { success: true, queued: true };
      }
      return { success: true };
    } catch (e) {
      if (e?.code === 'SECURITY_CONTEXT_EXPIRED') return { success: false, error: 'The account context expired before the dispute response completed.' };
      if (event) {
        try {
          assertSecurityContextOwner(identity?.securityFence, identity?.pk);
          await enqueueNostrEvent(event, null, identity.securityFence);
          return { success: true, queued: true };
        } catch (queueError) {
          console.error('[useReputation] Could not queue dispute rider:', queueError);
        }
      }
      return { success: false, error: e.message };
    }
  }, [identity]);

  return { reputation, loading, fetchReputation, sendVouch, sendReview, sendRider };
}
