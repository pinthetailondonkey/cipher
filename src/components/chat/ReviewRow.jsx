import { Star } from 'lucide-react';
import Badge from '../ui/Badge';
import { noHexName } from '../../lib/npub';
import { monthLabelOf } from '../../lib/vendorReviews';

// A rider's plain label, per VOICE: no invented legal copy, just who said
// it and what kind of word it was.
const RIDER_LABELS = {
  'vendor-flag': 'The vendor flagged this',
  'vendor-rebuttal': 'The vendor rebutted',
  'buyer-supplement': 'The buyer added',
};

// One review row on the vendor's identity page. The reviewer's display
// name, the stars, a one-line verdict, and the order month — never the
// item, never the amount. The receipt chip rides only when the bound
// receipt reads confirmed on chain. A wire rider of record (the vendor's
// flag or rebuttal, the buyer's supplement) renders as a plain line under
// the row it rides.
export default function ReviewRow({ review, profile = {}, verified = false }) {
  const name = noHexName(profile, review.buyerPubkey);
  const riders = Array.isArray(review.riders) ? review.riders : [];
  return (
    <div className="border-b border-line px-4 py-3 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{name}</span>
        <span className="flex shrink-0 items-center gap-0.5" aria-label={`Rated ${review.stars} of 5 stars`}>
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              size={12}
              aria-hidden="true"
              className={star <= review.stars ? 'text-accentText' : 'text-ink/25'}
              fill={star <= review.stars ? 'currentColor' : 'none'}
            />
          ))}
        </span>
      </div>
      {review.verdict && <p className="mt-1 text-[14px] leading-snug text-ink/75">{review.verdict}</p>}
      {riders.map((rider) => (
        <p
          key={rider.id || `${rider.rider}-${rider.text}`}
          className="mt-1.5 rounded-xl bg-panelAlt px-3 py-2 text-[13px] leading-snug text-ink/75"
        >
          <span className="font-semibold text-ink">{RIDER_LABELS[rider.rider] || 'A rider'}</span>
          <span>: {rider.text}</span>
        </p>
      ))}
      <div className="mt-1.5 flex items-center gap-2">
        {verified && (
          <Badge tone="success" aria-label="Receipt on chain">
            Receipt on chain
          </Badge>
        )}
        {review.orderMonth && <span className="text-[11px] text-inkSubtle">{monthLabelOf(review.orderMonth)}</span>}
      </div>
    </div>
  );
}
