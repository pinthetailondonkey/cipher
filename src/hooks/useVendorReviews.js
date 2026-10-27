import { useEffect, useState } from 'react';
import { averageRating } from '../lib/reputation';
import {
  dealsProvenForVendor,
  monthsActiveForVendor,
  reviewSummaryOf,
  reviewsForVendor,
} from '../lib/vendorReviews';

// The standing numbers a vendor's menu and identity page read off this
// device: proven deals, months active, and the reviews that still verify
// against their bound receipts. One load per vendor; nothing listens to
// the database, so surfaces that change a review re-run the loader.
export function useVendorReviews({ vendorPubkey, refreshKey = 0 }) {
  const [state, setState] = useState({
    dealsProven: 0,
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
        const reviews = await reviewsForVendor(vendorPubkey);
        if (!active) return;
        setState({
          dealsProven: dealsProvenForVendor(vendorPubkey),
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
    return () => { active = false; };
  }, [vendorPubkey, refreshKey]);

  return state;
}
