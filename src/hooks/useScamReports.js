import { useState, useEffect } from 'react';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryWithTimeout } from '../lib/relays';

export function useScamReports({ identity, targetPubkey }) {
  const [isScammer, setIsScammer] = useState(false);
  const [reportCount, setReportCount] = useState(0);

  useEffect(() => {
    if (!targetPubkey || !identity?.sk) return;
    let mounted = true;

    const fetchReports = async () => {
      try {
        const pool = await getAuthenticatedPool(identity);
        // Kind 1984 is the standard NIP-56 report event
        const events = await queryWithTimeout(pool, generalRelays, {
          kinds: [1984],
          '#p': [targetPubkey],
          limit: 50
        }, 4000);

        if (!mounted) return;

        // Count unique reporters
        const uniqueReporters = new Set();
        events.forEach(ev => {
          const typeTag = ev.tags.find(t => t[0] === 'report')?.[1];
          // Only count if they tagged it as a scam/spam
          if (typeTag === 'scam' || typeTag === 'spam' || typeTag === 'impersonation' || !typeTag) {
            uniqueReporters.add(ev.pubkey);
          }
        });

        const count = uniqueReporters.size;
        setReportCount(count);
        setIsScammer(count >= 3); // Threshold for the red banner
      } catch (err) {
        console.error('Failed to fetch reports:', err);
      }
    };

    fetchReports();
    return () => { mounted = false; };
  }, [targetPubkey, identity?.sk]);

  return { isScammer, reportCount };
}