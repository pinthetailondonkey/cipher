import { useState } from 'react';
import { Star } from 'lucide-react';
import Sheet from '../ui/Sheet';
import Input from '../ui/Input';
import Button from '../ui/Button';
import Avatar from '../ui/Avatar';
import { pushToast } from '../ui/toast';
import { createReviewPublisher, monthLabelOf, saveReview } from '../../lib/vendorReviews';
import { useReputation } from '../../hooks/useReputation';
import { noHexName } from '../../lib/npub';
import { haptic } from '../../lib/haptics';

// The review sheet, offered only where the deal itself qualified: a bound
// receipt on this device, the buyer's key on it, the deal completed.
// Stars and a one-line verdict; the bound receipt hash is the purchase
// evidence. The sheet derives NOTHING about the date — the order month
// comes from the receipt at display time, so no flattering month is ever
// submitted. Submit is sign-and-publish: the publisher (main's sendReview,
// through createReviewPublisher) signs kind 10005 over the wire, and the
// local record is always kept beside the publication so the
// one-per-receipt door and the offline history survive. A publish refusal
// keeps the local save and reports itself honestly — no fake success.
export default function ReviewCompose({ offer, vendorProfile = {}, identity = null, open, onClose }) {
  const { sendReview } = useReputation({ identity });
  const [stars, setStars] = useState(0);
  const [verdict, setVerdict] = useState('');
  const [saving, setSaving] = useState(false);
  const [publishError, setPublishError] = useState('');
  const vendorName = noHexName(vendorProfile, offer?.vendorPubkey);

  const save = async () => {
    if (!offer || stars < 1 || !verdict.trim() || saving) return;
    setSaving(true);
    setPublishError('');
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
      let result;
      try {
        result = await createReviewPublisher({ sendReview })({
          vendorPubkey: offer.vendorPubkey,
          stars,
          verdict,
          receiptHash: offer.receipt.hash,
        });
      } catch (error) {
        console.error('[ReviewCompose] The review could not be published:', error);
        result = { success: false, error: error?.message };
      }
      if (result?.success) {
        pushToast({ type: 'success', message: 'Your review is published.' });
        haptic('light');
        onClose?.();
      } else {
        // The local save stands; the wire told us what it did not take.
        setPublishError(result?.error || 'The review could not be published.');
      }
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

        {publishError && (
          <p role="alert" className="mt-3 rounded-xl border border-line bg-panelStrong px-3 py-2 text-[13px] text-danger">
            {publishError}
          </p>
        )}

        <p className="mt-3 text-[12px] text-inkSubtle">
          Published under this account, open to anyone who reads the vendor. Only the order month shows beside it — never the item or the amount.
        </p>

        <Button
          type="submit"
          size="lg"
          fullWidth
          disabled={stars < 1 || !verdict.trim()}
          className="mt-4"
        >
          {saving ? 'Publishing…' : 'Publish review'}
        </Button>
      </form>
    </Sheet>
  );
}
