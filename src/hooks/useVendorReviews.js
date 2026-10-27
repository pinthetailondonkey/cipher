import { useEffect, useState } from 'react';
import { averageRating } from '../lib/reputation';
import {
  REVIEW_WIRING_LANDED,
  monthsActiveForVendor,
  provenDealsForVendor,
  reviewSummaryOf,
  reviewsForVendor,
} from '../lib/vendorReviews';

// The standing numbers a vendor's menu and identity page read off this
// device: proven deals keyed by rail ({ btc: { count, txids, phrasing },
// ... }), months active, and the reviews the reader contract admits. One
// load per vendor; nothing listens to the database, so surfaces that
// change a review re-run the loader.
//
// dealsProvenFor(vendorPubkey) stays the single seam; provider swaps to
// Deal-lane txid-bulletin contract (see DATA-LAYER owner on main) touch
// this file alone. Pass `dealsProvenOf` to override the fallback here.
// Review rows render only from Deal's reader contract: until that folds
// (REVIEW_WIRING_LANDED) the list is empty, though rows saved locally sit
// ready in the account database.
export function useVendorReviews({ vendorPubkey, refreshKey = 0, dealsProvenOf }) {
  const [state, setState] = useState({
    proven: {},
    monthsActive: 0,
    reviews: [],
    summary: { count: 0, average: '0.0' },
    loading: Boolean(vendorPubkey),
  });

  useEffect(() => {
    if (!vendorPubkey) return undefined;
    let active = true;
    const load = async () => {
      try {
        const reviews = REVIEW_WIRING_LANDED ? await reviewsForVendor(vendorPubkey) : [];
        if (!active) return;
        setState({
          proven: dealsProvenOf ? dealsProvenOf(vendorPubkey) : provenDealsForVendor(vendorPubkey),
          monthsActive: monthsActiveForVendor(vendorPubkey),
          reviews,
          summary: reviewSummaryOf(reviews, averageRating),
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
  }, [vendorPubkey, refreshKey]);

  return state;
}
