import { Star } from 'lucide-react';
import Badge from '../ui/Badge';
import { noHexName } from '../../lib/npub';
import { monthLabelOf } from '../../lib/vendorReviews';

// One review row on the vendor's identity page. The reviewer's display
// name, the stars, a one-line verdict, and the order month — never the
// item, never the amount. "Verified purchase" rides only when the bound
// receipt reads confirmed on chain.
export default function ReviewRow({ review, profile = {}, verified = false }) {
  const name = noHexName(profile, review.buyerPubkey);
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
      <div className="mt-1.5 flex items-center gap-2">
        {verified && (
          <Badge tone="success" aria-label="Verified purchase">
            Verified purchase
          </Badge>
        )}
        {review.orderMonth && <span className="text-[11px] text-inkSubtle">{monthLabelOf(review.orderMonth)}</span>}
      </div>
    </div>
  );
}
