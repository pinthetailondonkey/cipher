import { useCallback, useState } from 'react';
import { db } from '../db';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays } from '../lib/relays';
import { enqueueNostrEvent } from '../lib/outbox';
import { BULLETIN_KIND, bulletinContent, bulletinRefusal, bulletinTags } from '../lib/vendorStats';

export function useVendorStats({ identity, targetPubkey = null }) {
  const [stats, setStats] = useState({ sales: 0, revenueFiat: 0, btc: 0, xmr: 0, badges: [] });
  const [loading, setLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    const pkToFetch = targetPubkey || identity?.pk;
    if (!pkToFetch) return;
    setLoading(true);
    try {
      const allMsgs = await db.messages.toArray();
      
      const completedIds = new Set();
      allMsgs.forEach(m => {
        if (m.data?.type === 'order_update' && m.data?.status === 'completed') {
          completedIds.add(m.data.orderId);
        }
      });

      const orders = allMsgs.filter(m => !m.isSender && (m.data?.type === 'cipher_order' || m.data?.type === 'order_request'));
      
      let sales = 0;
      let revenueFiat = 0;
      let btc = 0;
      let xmr = 0;

      orders.forEach(o => {
        const isCompleted = completedIds.has(o.id) || completedIds.has(o.clientId) || o.data.status === 'completed';
        if (isCompleted) {
          sales++;
          const product = o.data.product || o.data;
          const currency = (product.currency || o.data.currency || 'USD').toUpperCase();
          const price = Number(product.amountFiat || product.priceUsd || product.price || o.data.amountFiat || 0);
          const cryptoAmt = Number(product.amountCrypto || o.data.amountCrypto || (currency === 'BTC' || currency === 'XMR' ? product.price : 0) || 0);
          if (currency === 'USD') revenueFiat += Number.isFinite(price) ? price : 0;
          if (currency === 'BTC') btc += Number.isFinite(cryptoAmt) ? cryptoAmt : 0;
          if (currency === 'XMR') xmr += Number.isFinite(cryptoAmt) ? cryptoAmt : 0;
        }
      });

      const badges = [];
      if (sales >= 1) badges.push({ id: 'first_sale', name: 'First Sale', icon: '🏆', color: 'text-accent' });
      if (sales >= 100) badges.push({ id: 'diamond_hands', name: 'Diamond Hands', icon: '💎', color: 'text-accent' });
      if (revenueFiat >= 1000) badges.push({ id: 'high_roller', name: '$1K Volume', icon: '💰', color: 'text-green-400' });
      if (revenueFiat >= 10000) badges.push({ id: 'whale', name: '$10K Volume', icon: '🐋', color: 'text-purple-400' });

      setStats({ sales, revenueFiat, btc, xmr, badges });
    } catch (e) {
      console.error('Failed to fetch vendor stats', e);
    } finally {
      setLoading(false);
    }
  }, [identity, targetPubkey]);

  // The vendor publishes the txids themselves — the proven count is the list,
  // never a number typed over it (src/lib/vendorStats.js is the law). The
  // refusal runs before anything is signed, and the event is replaceable per
  // rail: a re-publish for the same rail supersedes, nothing is deleted.
  const publishBulletin = useCallback(async (rail, txids) => {
    const refusal = bulletinRefusal(rail, txids);
    if (refusal) return { success: false, error: refusal };
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const event = finalizeEvent({
        kind: BULLETIN_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: bulletinTags(rail),
        content: bulletinContent(txids),
      }, identity.sk);
      const pool = await getAuthenticatedPool(identity);
      const results = await Promise.allSettled(pool.publish(generalRelays, event));
      if (!results.some((result) => result.status === 'fulfilled')) {
        await enqueueNostrEvent(event);
        return { success: true, queued: true };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }, [identity]);

  return { stats, loading, fetchStats, publishBulletin };
}