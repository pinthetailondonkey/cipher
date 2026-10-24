import { useCallback, useState } from 'react';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryWithTimeout } from '../lib/relays';
import { enqueueNostrEvent } from '../lib/outbox';

// Defense layer cache — profile timestamps keyed by pubkey
// Prevents re-fetching the same profile on every modal open
import { scopedGet, scopedSet } from '../lib/storage';
const PROFILE_CACHE_KEY = 'rep_profile_cache';
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const MIN_VOUCHER_AGE_DAYS = 7;

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
    setLoading(true);

    try {
      const pool = await getAuthenticatedPool(identity);

      // 1. Fetch raw vouches + reviews
      const [vouchEvents, reviews] = await Promise.all([
        queryWithTimeout(pool, generalRelays, { kinds: [10004], '#p': [targetPubkey] }, 3000),
        queryWithTimeout(pool, generalRelays, { kinds: [10005], '#p': [targetPubkey] }, 3000)
      ]);
      const rawVouches = vouchEvents.filter((event) => (
        event.tags.some((tag) => tag[0] === 'p' && tag[1] === targetPubkey) &&
        event.tags.some((tag) => tag[0] === 'vouch' && tag[1] === 'true')
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
      const cachedPubkeys = Object.keys(cache);

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
            generalRelays,
            { kinds: [0], authors: toFetch },
            3000
          );
        } catch {}
      }

      // Merge into cache
      for (const ev of freshProfiles) {
        let meta = {};
        try { meta = JSON.parse(ev.content); } catch {}
        cache[ev.pubkey] = {
          createdAt: ev.created_at,          // profile's last update time
          fetchedAt: now,
          name: meta.display_name || meta.name || ev.pubkey.slice(0, 6),
          picture: meta.picture || null,
        };
      }
      saveProfileCache(cache);

      // 4. Filter vouches by age + build voucher display objects
      const minAgeSec = MIN_VOUCHER_AGE_DAYS * 24 * 60 * 60;
      const nowSec = Math.floor(now / 1000);
      const validVouchers = [];
      const filteredVouchers = [];

      for (const ev of vouchesAfterSelf) {
        const profile = cache[ev.pubkey];
        const ageSec = profile ? (nowSec - profile.createdAt) : 0;
        const valid = profile && ageSec >= minAgeSec;

        const info = {
          pubkey: ev.pubkey,
          name: profile?.name || `User ${ev.pubkey.slice(0, 4)}`,
          picture: profile?.picture || null,
          ageDays: Math.floor(ageSec / 86400),
          valid,
          reason: !profile ? 'no-profile' : (ageSec < minAgeSec ? 'too-new' : null),
        };

        if (valid) validVouchers.push(info);
        else filteredVouchers.push(info);
      }

      // 5. Reviews (also self-review protected)
      const validReviews = reviews.filter((ev) => ev.pubkey !== targetPubkey);
      let avgRating = 0;
      if (validReviews.length > 0) {
        const sum = validReviews.reduce(
          (acc, ev) => acc + parseInt(ev.tags.find((t) => t[0] === 'rating')?.[1] || '0'),
          0
        );
        avgRating = (sum / validReviews.length).toFixed(1);
      }

      const hasVouched = vouchesAfterSelf.some((ev) => ev.pubkey === identity.pk);

      setReputation({
        // Trusted count only includes age-validated vouchers
        vouchCount: validVouchers.length,
        rawVouchCount: rawVouches.length,
        filteredCount: filteredVouchers.length,
        vouchList: validVouchers,
        filteredList: filteredVouchers,
        reviewCount: validReviews.length,
        avgRating,
        hasVouched,
        recentReviews: validReviews.slice(0, 3).map((ev) => ({
          pubkey: ev.pubkey,
          rating: parseInt(ev.tags.find((t) => t[0] === 'rating')?.[1] || '0'),
          text: ev.content,
        })),
      });
    } catch (e) {
      console.error('[useReputation] fetch failed:', e);
    } finally {
      setLoading(false);
    }
  }, [identity]);

  const sendVouch = useCallback(async (targetPubkey) => {
    // Defense Layer 1: refuse to vouch yourself
    if (!targetPubkey || !identity?.pk || !identity?.sk) {
      return { success: false, error: 'Unlock your account before vouching.' };
    }
    if (targetPubkey === identity.pk) {
      return { success: false, error: 'Cannot vouch for yourself' };
    }

    let event;
    try {
      const { finalizeEvent } = await import('nostr-tools');
      event = finalizeEvent({
        kind: 10004,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', targetPubkey], ['vouch', 'true']],
        content: 'Vouched via Cipher',
      }, identity.sk);

      const pool = await getAuthenticatedPool(identity);
      const results = await Promise.allSettled(pool.publish(generalRelays, event));
      if (!results.some((result) => result.status === 'fulfilled')) {
        await enqueueNostrEvent(event);
        return { success: true, queued: true };
      }
      // Refetch to recalculate trust (invalid vouches still don't count)
      await fetchReputation(targetPubkey);
      return { success: true };
    } catch (e) {
      if (event) {
        try {
          await enqueueNostrEvent(event);
          return { success: true, queued: true };
        } catch (queueError) {
          console.error('[useReputation] Could not queue vouch:', queueError);
        }
      }
      return { success: false, error: e.message };
    }
  }, [identity, fetchReputation]);

  const sendReview = useCallback(async (targetPubkey, rating, text) => {
    if (targetPubkey === identity.pk) {
      return { success: false, error: 'Cannot review yourself' };
    }
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const ev = finalizeEvent({
        kind: 10005,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', targetPubkey], ['rating', rating.toString()]],
        content: text,
      }, identity.sk);
      await Promise.allSettled(pool.publish(generalRelays, ev));
      await fetchReputation(targetPubkey);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }, [identity, fetchReputation]);

  return { reputation, loading, fetchReputation, sendVouch, sendReview };
}
