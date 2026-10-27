import { useState } from 'react';
import { ArrowLeft, Star } from 'lucide-react';
import { pressable } from '../ui/Button';
import Button from '../ui/Button';
import Textarea from '../ui/Textarea';
import Sheet from '../ui/Sheet';
import Chip from '../ui/Chip';
import Avatar from '../ui/Avatar';
import { pushToast } from '../ui/toast';
import { shortNpub, noHexName } from '../../lib/npub';
import { haptic } from '../../lib/haptics';
import { useReputation } from '../../hooks/useReputation';
import { monthLabelOf, riderComposeOf } from '../../lib/vendorReviews';
import ProvenBanner from './ProvenBanner';
import ReviewRow from './ReviewRow';

// The words a rider's compose sheet speaks, plain per VOICE — who may say
// them and the single-shot fact of each.
const RIDER_COMPOSE = {
  'vendor-flag': { heading: 'Flag this review', button: 'Flag it', note: 'You get one flag for this review. It goes out under the vendor\'s own signature and it cannot be taken back.' },
  'vendor-rebuttal': { heading: 'Rebut this review', button: 'Rebut', note: 'You get one rebuttal for this review. Say your side in one line.' },
  'buyer-supplement': { heading: 'Add to your review', button: 'Post it', note: 'You get one supplement for this review. It goes out under your own signature and it cannot be taken back.' },
};

// The vendor's public identity page. Opened from the menu's header: the
// rating summary when reviews exist, the receipt-bound review list, and the
// standing row — deals proven and the vouch summary in plain words. No
// tiers, no badges beyond the purchase mark.
//
// The dispute compose law: the vendor who owns this thread flags or rebuts
// their review rows, the buyer supplements their own row, anyone else sees
// no affordance at all — riderComposeOf checks BOTH the wire's rider of
// record and this device's own signed ledger, so a word spent once refuses
// the second per word, per pair.
export default function VendorProfilePage({
  vendorPubkey,
  profile = {},
  profiles = {},
  identity = null,
  vouchCount = 0,
  disputes = [],
  standing = { dealsProven: 0, monthsActive: 0 },
  reviews = [],
  summary = { count: 0, average: '0.0' },
  loading = false,
  onBack,
}) {
  const { sendRider } = useReputation({ identity });
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const name = noHexName(profile, vendorPubkey);

  const openRider = (row, rider) => {
    haptic('light');
    setError('');
    setText('');
    setDraft({ row, rider });
  };
  const postRider = async () => {
    const body = text.trim();
    if (!draft || !body || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await sendRider({
        vendor: draft.row.vendorPubkey,
        receiptHash: draft.row.receiptHash,
        review: draft.row.id,
        rider: draft.rider,
        text: body,
      });
      if (result?.success) {
        pushToast({ type: 'success', message: 'Posted.' });
        haptic('light');
        setDraft(null);
      } else {
        setError(result?.error || 'The rider could not be posted.');
      }
    } catch (postError) {
      console.error('[VendorProfilePage] The rider could not be posted:', postError);
      setError(postError?.message || 'The rider could not be posted.');
    } finally {
      setSaving(false);
    }
  };
  const sheet = draft ? (RIDER_COMPOSE[draft.rider] || RIDER_COMPOSE['buyer-supplement']) : null;

  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-label={`${name} profile`}>
      <header className="glass-header sticky top-0 z-fab flex items-center gap-2 px-2 py-3 pt-[env(safe-area-inset-top)]">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to the menu" className={`p-2 text-ink ${pressable}`}>
            <ArrowLeft size={22} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar src={profile.picture} name={name} size={44} />
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-bold tracking-tight text-ink">{name}</h1>
            <p className="mono truncate text-[12px] text-inkSubtle">{shortNpub(vendorPubkey, 16)}</p>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
        {summary.count > 0 && (
          <section className="rounded-2xl border border-line bg-panelStrong px-4 py-4">
            <div className="flex items-center gap-3">
              <p className="text-[26px] font-bold tracking-tight text-ink">{summary.average}</p>
              <div aria-hidden="true" className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star key={star} size={13} className="text-accentText" fill="currentColor" />
                ))}
              </div>
            </div>
            <p className="mt-0.5 text-[13px] text-inkMuted">
              {summary.count} {summary.count === 1 ? 'review' : 'reviews'}
            </p>
          </section>
        )}

        <section className="mt-3" aria-label="Standing">
          <ProvenBanner proven={standing.proven} />
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip>Standing · {vouchCount} {vouchCount === 1 ? 'vouch' : 'vouches'}</Chip>
          </div>
        </section>

        {reviews.length > 0 && (
          <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panelStrong">
            <p className="border-b border-line px-4 py-2.5 text-[13px] text-inkMuted">Reviews</p>
            {reviews.map((review, index) => (
              <ReviewRow
                key={review.receiptHash || `${review.id || ''}-${index}`}
                review={review}
                profile={profiles[review.buyerPubkey] || {}}
                verified={review.receipt?.body?.outcome === 'confirmed'}
                composeWords={riderComposeOf(review, { authorPubkey: identity?.pk, disputeEvents: disputes })}
                onCompose={(rider) => openRider(review, rider)}
              />
            ))}
          </section>
        )}
        {reviews.length === 0 && (
          <p className="mt-5 px-1 text-[13px] text-inkSubtle">
            {loading ? 'Reading reviews…' : 'No reviews yet.'}
          </p>
        )}

        <Sheet
          open={Boolean(draft)}
          onClose={() => setDraft(null)}
          heading={sheet?.heading}
          ariaLabel={sheet?.heading}
        >
          {draft && (
            <form
              onSubmit={(event) => { event.preventDefault(); postRider(); }}
              className="pb-4"
            >
              {error && (
                <p role="alert" className="rounded-xl border border-line bg-panelStrong px-3 py-2 text-[13px] text-danger">
                  {error}
                </p>
              )}
              <p className="mt-1 text-[12px] text-inkSubtle">{sheet?.note}</p>
              <div className="mt-3">
                <Textarea
                  label="What happened"
                  value={text}
                  maxLength={280}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Say it in one line."
                />
              </div>
              <Button type="submit" size="lg" fullWidth disabled={!text.trim()} className="mt-4">
                {saving ? 'Posting…' : sheet?.button}
              </Button>
            </form>
          )}
        </Sheet>
      </div>
    </section>
  );
}
