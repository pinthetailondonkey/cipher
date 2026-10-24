import { useCallback, useState, useEffect } from 'react';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryWithTimeout } from '../lib/relays';

export function useVouchCount({ identity, targetPubkey }) {
  const [vouchCount, setVouchCount] = useState(0);
  const [hasVouched, setHasVouched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!targetPubkey || !identity?.sk) {
      setLoading(false);
      return;
    }
    let mounted = true;

    const fetchVouches = async () => {
      try {
        const pool = await getAuthenticatedPool(identity);
        // Kind 10004 = Cipher Vouch Event
        const events = await queryWithTimeout(pool, generalRelays, {
          kinds: [10004],
          '#p': [targetPubkey],
          limit: 200
        }, 4000);

        if (!mounted) return;

        // Deduplicate by reporter (one vouch per unique pubkey)
        const uniqueVouchers = new Set();
        events.forEach(ev => {
          const explicitlyVouches = ev.tags.some((tag) => tag[0] === 'vouch' && tag[1] === 'true');
          if (
            ev.kind === 10004 &&
            ev.pubkey !== targetPubkey &&
            explicitlyVouches &&
            ev.tags.some((tag) => tag[0] === 'p' && tag[1] === targetPubkey)
          ) {
            uniqueVouchers.add(ev.pubkey);
          }
        });

        setVouchCount(uniqueVouchers.size);
        setHasVouched(uniqueVouchers.has(identity.pk));
      } catch (err) {
        console.error('Failed to fetch vouches:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchVouches();
    return () => { mounted = false; };
  }, [targetPubkey, identity?.pk, identity?.sk, refreshKey]);

  const tier = vouchCount >= 10 ? 'elite' : vouchCount >= 3 ? 'trusted' : 'new';
  return { vouchCount, tier, loading, hasVouched, refresh };
}