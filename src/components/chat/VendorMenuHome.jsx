import { useEffect, useState } from 'react';
import { X, QrCode, Link2, MessageCircle, Package, Store } from 'lucide-react';
import { useVouchCount } from '../../hooks/useVouchCount';
import { useVendorReviews } from '../../hooks/useVendorReviews';
import { generalRelays } from '../../lib/relays';
import { listingFromEvent, menuShareLink, priceLabel } from '../../lib/listing';
import Button, { pressable } from '../ui/Button';
import Chip from '../ui/Chip';
import Avatar from '../ui/Avatar';
import { ProductImage } from '../ui/PrivateMedia';
import EmptyState from '../ui/EmptyState';
import { SkeletonGrid } from '../ui/Skeleton';
import { useModalA11y } from '../ui/modal';
import Sheet from '../ui/Sheet';
import { QRCodeSVG } from 'qrcode.react';
import { copyText } from '../../lib/copyText';
import { noHexName } from '../../lib/npub';
import { haptic } from '../../lib/haptics';
import { entryById } from '../../lib/egress';
import ProvenBanner from './ProvenBanner';
import VendorProfilePage from './VendorProfilePage';

// The vendor's menu home: a full screen on the phone, a pane docked to the
// right edge on wide screens. The header band carries the identity (the
// avatar and name open the profile page) and the vouch row; the stats band
// carries the one number this app says in public — deals proven — with the
// months active and the standing summary beside it. The grid is the
// vendor's published listings; the footer keeps the vendor one tap away.
//
// `dealsProvenOf` is the stats-band seam: the count's real provider is the
// Deal lane's pending txid bulletin, so the lookup arrives as a prop (or
// falls back to the device's own proofOfTrade views). Swapping providers
// never touches this JSX.
export default function VendorMenuHome({ open, onClose, vendorPubkey, profiles = {}, identity, onOpenChat, onBuy, dealsProvenOf }) {
  // Shares build on the canonical app host the egress table names, not this
  // window's origin (the desktop build serves a loopback address).
  const APP_HOST_URL = entryById('app-host')?.url || '';
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState('menu');
  const [qrOpen, setQrOpen] = useState(false);
  const [pageVendor, setPageVendor] = useState(vendorPubkey);
  // A new vendor always opens on the menu, never on the page last read:
  // the reset adjusts state to the prop during render, no effect.
  if (pageVendor !== vendorPubkey) {
    setPageVendor(vendorPubkey);
    setPage('menu');
  }
  const { vouchCount, loading: vouchesLoading } = useVouchCount({ identity, targetPubkey: vendorPubkey });
  const standing = useVendorReviews({ vendorPubkey, identity, refreshKey: open ? 1 : 0, dealsProvenOf });
  const profile = profiles[vendorPubkey] || {};
  const name = noHexName(profile, vendorPubkey);
  const panelRef = useModalA11y(Boolean(open && vendorPubkey), onClose);

  useEffect(() => {
    if (!open || !vendorPubkey) return undefined;
    let active = true;
    let pool;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const { SimplePool } = await import('nostr-tools');
        pool = new SimplePool();
        const events = await pool.querySync(generalRelays, {
          kinds: [30402],
          authors: [vendorPubkey],
          '#t': ['cipher_marketplace'],
          limit: 50,
        });
        if (!active) return;
        setProducts(events.map(listingFromEvent).sort((a, b) => b.id.localeCompare(a.id)));
      } catch (loadError) {
        console.error('[VendorMenuHome] Menu fetch failed:', loadError);
        if (active) setError('Could not load this menu.');
      } finally {
        if (active) setLoading(false);
        pool?.close(generalRelays);
      }
    };
    load();
    return () => {
      active = false;
      pool?.close(generalRelays);
    };
  }, [open, vendorPubkey]);

  if (!open || !vendorPubkey) return null;

  const messageVendor = () => {
    haptic('light');
    onClose();
    onOpenChat?.(vendorPubkey);
  };

  if (page === 'profile') {
    return (
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${name} profile`}
        className="fixed inset-0 z-sheet flex flex-col bg-base outline-none md:inset-y-0 md:left-auto md:right-0 md:w-[440px] md:border-l md:border-line"
      >
        <VendorProfilePage
          vendorPubkey={vendorPubkey}
          profile={profile}
          profiles={profiles}
          identity={identity}
          vouchCount={vouchCount}
          disputes={standing.disputes}
          standing={{ proven: standing.proven, monthsActive: standing.monthsActive }}
          reviews={standing.reviews}
          summary={standing.summary}
          loading={standing.loading}
          onBack={() => setPage('menu')}
        />
      </section>
    );
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} menu`}
      className="fixed inset-0 z-sheet flex flex-col bg-base outline-none md:inset-y-0 md:left-auto md:right-0 md:w-[440px] md:border-l md:border-line"
    >
      <header className="glass-header flex items-center gap-2 px-2 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <button type="button" onClick={onClose} aria-label="Close menu" className={`p-2 text-ink ${pressable}`}>
          <X size={22} />
        </button>
        <button
          type="button"
          onClick={() => setPage('profile')}
          aria-label={`Open ${name}'s profile`}
          className={`flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-1 text-left ${pressable}`}
        >
          <Avatar src={profile.picture} name={name} size={44} className={profile.picture ? '' : 'text-inkSubtle'} />
          <div className="min-w-0">
            <h1 className="truncate text-[20px] font-bold tracking-tight text-ink">{name}</h1>
            <p className="text-[13px] text-inkMuted">
              {vouchesLoading ? 'Checking vouches…' : `${vouchCount} ${vouchCount === 1 ? 'vouch' : 'vouches'}`}
            </p>
          </div>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-3 pt-1" aria-label="Standing">
          <ProvenBanner proven={standing.proven} />
          <div className="mt-2 flex flex-wrap gap-2">
            {standing.monthsActive > 0 && (
              <Chip>Active {standing.monthsActive} {standing.monthsActive === 1 ? 'month' : 'months'}</Chip>
            )}
            {standing.monthsActive > 0 && (
              <Chip>Active {standing.monthsActive} {standing.monthsActive === 1 ? 'month' : 'months'}</Chip>
            )}
            <Chip>Standing · {vouchCount} {vouchCount === 1 ? 'vouch' : 'vouches'}</Chip>
          </div>
          {/* The whole menu travels as one link and one code: the share opens
              the storefront door directly (the same vendor key), and the QR
              draws that URL so a scan lands here without a typed address. */}
          <button
            type="button"
            aria-label="Copy menu link"
            onClick={() => { haptic('light'); copyText(menuShareLink(vendorPubkey, APP_HOST_URL)); }}
            className={`flex min-h-[36px] items-center gap-1 rounded-full border border-line px-3 text-[12px] font-semibold text-inkMuted ${pressable}`}
          >
            <Link2 size={14} aria-hidden="true" /> Menu link
          </button>
          <button
            type="button"
            aria-label="Show menu QR code"
            onClick={() => { haptic('light'); setQrOpen(true); }}
            className={`flex min-h-[36px] items-center gap-1 rounded-full border border-line px-3 text-[12px] font-semibold text-inkMuted ${pressable}`}
          >
            <QrCode size={14} aria-hidden="true" /> Show QR
          </button>
        </div>

        {profile.about && (
          <div className="mx-4 mb-3 overflow-hidden rounded-2xl border border-line bg-panelStrong">
            <p className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle">About</p>
            <p className="px-4 py-3 text-[14px] leading-snug text-ink/75">{profile.about}</p>
          </div>
        )}

        <div className="px-4 pb-4">
          {error && (
            <p role="alert" className="rounded-2xl border border-line bg-panelStrong px-4 py-5 text-center text-[13px] text-danger">
              {error}
            </p>
          )}
          {loading && <SkeletonGrid cols={4} />}
          {!loading && !error && products.length === 0 && (
            <EmptyState icon={<Store size={20} />} title="Nothing on the menu yet">
              Check back later, or tap Message vendor below.
            </EmptyState>
          )}
          {!loading && products.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {products.map((product) => (
                <article key={product.id} className="overflow-hidden rounded-2xl border border-line bg-panelStrong">
                  <ProductImage
                    value={product.image}
                    alt=""
                    loading="lazy"
                    className={`aspect-[4/5] w-full border-b border-line object-cover ${product.soldOut ? 'opacity-50' : ''}`}
                    fallback={
                      <div className="flex aspect-[4/5] w-full items-center justify-center border-b border-line bg-panelAlt text-inkSubtle">
                        <Package size={22} />
                      </div>
                    }
                  />
                  {product.soldOut && (
                    <span className="absolute left-2 top-2 rounded-full bg-scrim/80 px-2 py-0.5 text-[11px] font-bold text-scrim">Sold out</span>
                  )}
                  <div className="space-y-1 p-3">
                    <h2 className="line-clamp-2 min-h-[2.2em] text-[14px] font-semibold leading-snug text-ink">{product.name}</h2>
                    <p className="mono truncate text-[13px] font-semibold text-accentText">
                      {priceLabel(product.price, product.currency) || 'Ask'}
                    </p>
                    {/* A sold-out listing cannot start an order; the button
                        dims rather than vanishes so the card keeps its shape. */}
                    {product.soldOut ? (
                      <span aria-disabled="true" className="block w-full cursor-not-allowed select-none rounded-xl bg-accent/40 py-2.5 text-center text-[13px] font-bold text-accentInk">Buy</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          haptic('light');
                          onBuy?.(product, vendorPubkey);
                        }}
                        className="w-full rounded-xl bg-accent py-2.5 text-[13px] font-bold text-accentInk"
                      >
                        Buy
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-line bg-panel px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
        <Button size="lg" fullWidth leadingIcon={<MessageCircle size={17} />} onClick={messageVendor}>
          Message vendor
        </Button>
      </footer>

      {/* The QR is this menu's whole link: one scan opens the storefront, the
          same door every in-app entry already uses. */}
      <Sheet open={qrOpen} onClose={() => setQrOpen(false)} title="Menu QR code">
        <div className="flex flex-col items-center gap-3 px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-2">
          <QRCodeSVG value={menuShareLink(vendorPubkey, APP_HOST_URL)} size={200} level="M" />
          <p className="break-all text-center text-[11px] text-inkSubtle">{menuShareLink(vendorPubkey, APP_HOST_URL)}</p>
          <Button fullWidth onClick={() => { haptic('light'); copyText(menuShareLink(vendorPubkey, APP_HOST_URL)); }}>
            Copy menu link
          </Button>
        </div>
      </Sheet>
    </section>
  );
}
