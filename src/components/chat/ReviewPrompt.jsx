import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { getReviewForReceipt } from '../../lib/vendorReviews';
import ReviewCompose from './ReviewCompose';

// The "Review this deal" door on an order card. The offer arrives already
// gated (a bound receipt on this device, the buyer's key, the deal
// completed), so with no offer this renders nothing. Once this deal has a
// review, the door stays down — one review per receipt. The identity rides
// along so the composer can sign what it publishes.
export default function ReviewPrompt({ offer, vendorProfile = {}, identity = null }) {
  const [alreadyReviewed, setAlreadyReviewed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!offer?.receipt?.hash) return undefined;
    let active = true;
    getReviewForReceipt(offer.receipt.hash).then((existing) => {
      if (active) setAlreadyReviewed(Boolean(existing));
    }).catch(() => {
      if (active) setAlreadyReviewed(false);
    });
    return () => { active = false; };
  }, [offer?.receipt?.hash]);

  if (!offer || alreadyReviewed) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl border border-line px-3 py-2.5 text-[13px] font-semibold text-accentText active:bg-ink/5"
      >
        <Star size={15} aria-hidden="true" />
        Review this deal
      </button>
      <ReviewCompose offer={offer} vendorProfile={vendorProfile} identity={identity} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
