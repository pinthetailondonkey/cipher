import { useState } from 'react';
import { Star } from 'lucide-react';
import Sheet from '../ui/Sheet';
import Input from '../ui/Input';
import Button from '../ui/Button';
import Avatar from '../ui/Avatar';
import { pushToast } from '../ui/toast';
import { monthLabelOf, saveReview } from '../../lib/vendorReviews';
import { noHexName } from '../../lib/npub';
import { haptic } from '../../lib/haptics';

// The review sheet, offered only where the deal itself qualified: a bound
// receipt on this device, the buyer's key on it, the deal completed.
// Stars and a one-line verdict; the bound receipt hash is the purchase
// evidence. The sheet derives NOTHING about the date — the order month
// comes from the receipt at display time, so no flattering month is ever
// submitted. The review saves to this account's own database; nothing is
// sent until Deal's kind-10005 publisher folds in
// (createReviewPublisher, "publisher swaps to Deal-lane kind-10005
// publisher on fold").
export default function ReviewCompose({ offer, vendorProfile = {}, open, onClose }) {
  const [stars, setStars] = useState(0);
  const [verdict, setVerdict] = useState('');
  const [saving, setSaving] = useState(false);
  const vendorName = noHexName(vendorProfile, offer?.vendorPubkey);

  const save = async () => {
    if (!offer || stars < 1 || !verdict.trim() || saving) return;
    setSaving(true);
    try {
      // No date rides the submission: the month is derived display-side
      // from the receipt the row keeps bound to.
      await saveReview({
        vendorPubkey: offer.vendorPubkey,
        buyerPubkey: offer.buyerPubkey,
        stars,
        verdict,
        receiptHash: offer.receipt.hash,
        orderId: offer.orderId,
        receipt: offer.receipt,
      });
      pushToast({ type: 'success', message: 'Your review is saved.' });
      haptic('light');
      onClose?.();
    } catch (error) {
      console.error('[ReviewCompose] The review could not be saved:', error);
      pushToast({ type: 'error', message: error?.message || 'Your review could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} heading="Review this deal" ariaLabel="Review this deal">
      <form
        onSubmit={(event) => { event.preventDefault(); save(); }}
        className="pb-4"
      >
        <div className="flex items-center gap-3">
          <Avatar src={vendorProfile.picture} name={vendorName} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-ink">{vendorName}</p>
            {offer?.orderMonth && <p className="text-[13px] text-inkMuted">{monthLabelOf(offer.orderMonth)}</p>}
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-2 text-[12px] font-medium text-inkMuted">Stars</legend>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => { haptic('light'); setStars(star); }}
                aria-label={`Rate ${star} of 5 stars`}
                aria-pressed={stars === star}
                className="rounded-full p-1.5 active:bg-ink/5"
              >
                <Star
                  size={28}
                  aria-hidden="true"
                  className={star <= stars ? 'text-accentText' : 'text-ink/25'}
                  fill={star <= stars ? 'currentColor' : 'none'}
                />
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-4">
          <Input
            label="One-line verdict"
            value={verdict}
            maxLength={140}
            onChange={(event) => setVerdict(event.target.value)}
            placeholder="Say it in one line."
          />
        </div>

        <p className="mt-3 text-[12px] text-inkSubtle">
          Saved to your own record. Only the order month shows beside it — never the item or the amount.
        </p>

        <Button
          type="submit"
          size="lg"
          fullWidth
          disabled={stars < 1 || !verdict.trim()}
          className="mt-4"
        >
          {saving ? 'Saving…' : 'Save review'}
        </Button>
      </form>
    </Sheet>
  );
}
