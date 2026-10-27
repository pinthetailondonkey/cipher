import { useEffect, useState } from 'react';
import { averageRating } from '../lib/reputation';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays } from '../lib/relays';
import { fetchVendorThread } from '../lib/vendorShopReaders';
import { dealsProvenFor } from '../lib/vendorStats';
import {
  REVIEW_WIRING_LANDED,
  boundReceiptsByHash,
  monthsActiveForVendor,
  provenDealsForVendor,
  reviewSummaryOf,
  reviewsForVendor,
  reviewsFromWire,
  ridersOfRow,
} from '../lib/vendorReviews';

// The standing numbers a vendor's menu and identity page read: proven deals
// keyed by rail ({ btc: { count, txids, phrasing }, ... }), months active,
// and the reviews of the vendor's LIVE thread — the wire rows fetched from
// Deal's reader contract (fetchVendorThread over the account's
// authenticated pool and the general relays), merged with the rows this
// device saved, keyed by receipt hash: a wire row is preferred when its
// signer is the local row's buyer, local-only rows stay visible.
//
// The proven provider is the publisher's: the vendor's txid bulletin
// (vendorStats.dealsProvenFor over the fetched bulletins) counts when it
// fetches, and the device-local derivation (provenDealsForVendor) covers a
// fetch with no bulletin — a rail with neither stays absent, never zeroed
// into a sum. The `dealsProvenOf` prop still overrides both for call sites
// that arrive with their own seam.
//
// One load per vendor; nothing listens to the database, so surfaces that
// change a review re-run the loader. Without an identity no pool exists, so
// the read degrades to the device's own rows — nothing is invented. The
// fetched dispute set rides along in `disputes` (the raw kind-10006 events)
// so the compose-side rider gate can read ridersForReview against it.
export function useVendorReviews({ vendorPubkey, identity = null, refreshKey = 0, dealsProvenOf }) {
  const [state, setState] = useState({
    proven: {},
    monthsActive: 0,
    reviews: [],
    disputes: [],
    summary: { count: 0, average: '0.0' },
    loading: Boolean(vendorPubkey),
  });

  useEffect(() => {
    if (!vendorPubkey) return undefined;
    let active = true;
    const load = async () => {
      try {
        const localRows = await reviewsForVendor(vendorPubkey);
        let proven = dealsProvenOf ? dealsProvenOf(vendorPubkey) : provenDealsForVendor(vendorPubkey);
        let rows = localRows;
        let disputeEvents = [];
        if (REVIEW_WIRING_LANDED && identity?.pk) {
          try {
            const pool = await getAuthenticatedPool(identity);
            const thread = await fetchVendorThread(pool, generalRelays, vendorPubkey);
            if (thread.bulletins.length && !dealsProvenOf) {
              // The published count is the txids; this replaces, never sums.
              proven = dealsProvenFor(vendorPubkey, thread.bulletins);
            }
            disputeEvents = thread.disputes;
            rows = reviewsFromWire({
              vendorPubkey,
              wireEvents: thread.reviews,
              localRows,
              receiptsByHash: boundReceiptsByHash(),
            }).map((row) => ({ ...row, riders: ridersOfRow(row, thread.disputes) }));
          } catch (fetchError) {
            console.error('[vendorReviews] The vendor thread could not be read:', fetchError);
            rows = localRows.map((row) => ({ ...row, riders: [] }));
          }
        } else {
          rows = localRows.map((row) => ({ ...row, riders: [] }));
        }
        if (!active) return;
        setState({
          proven,
          monthsActive: monthsActiveForVendor(vendorPubkey),
          reviews: rows,
          disputes: disputeEvents,
          summary: reviewSummaryOf(rows, averageRating),
          loading: false,
        });
      } catch (error) {
        console.error('[vendorReviews] Standing could not be read:', error);
        if (active) setState((current) => ({ ...current, loading: false }));
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [vendorPubkey, identity, refreshKey]);

  return state;
}
