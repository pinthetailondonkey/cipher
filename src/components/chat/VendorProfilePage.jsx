import { ArrowLeft, Star } from 'lucide-react';
import { pressable } from '../ui/Button';
import Chip from '../ui/Chip';
import Avatar from '../ui/Avatar';
import { shortNpub, noHexName } from '../../lib/npub';
import ProvenBanner from './ProvenBanner';
import ReviewRow from './ReviewRow';

// The vendor's public identity page. Opened from the menu's header: the
// rating summary when reviews exist, the verified-purchase review list,
// and the standing row — deals proven and the vouch summary in plain
// words. No tiers, no badges beyond the purchase mark.
export default function VendorProfilePage({
  vendorPubkey,
  profile = {},
  profiles = {},
  vouchCount = 0,
  standing = { dealsProven: 0, monthsActive: 0 },
  reviews = [],
  summary = { count: 0, average: '0.0' },
  loading = false,
  onBack,
}) {
  const name = noHexName(profile, vendorPubkey);
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
              />
            ))}
          </section>
        )}
        {reviews.length === 0 && (
          <p className="mt-5 px-1 text-[13px] text-inkSubtle">
            {loading ? 'Reading reviews…' : 'No reviews yet.'}
          </p>
        )}
      </div>
    </section>
  );
}
