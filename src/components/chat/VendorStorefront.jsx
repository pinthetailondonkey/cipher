import { useEffect, useState } from 'react';
import { MessageCircle, Package, ShieldCheck, Store } from 'lucide-react';
import { useVouchCount } from '../../hooks/useVouchCount';
import { generalRelays } from '../../lib/relays';
import Sheet from '../ui/Sheet';
import Avatar from '../ui/Avatar';
import Button from '../ui/Button';
import Picture from '../ui/Picture';
import EmptyState from '../ui/EmptyState';
import { SkeletonGrid } from '../ui/Skeleton';
import { noHexName } from '../../lib/npub';
import { haptic } from '../../lib/haptics';

function parseListing(event) {
  let content = {};
  try {
    content = JSON.parse(event.content || '{}');
  } catch (error) {
    console.warn('[VendorStorefront] Ignoring malformed vendor event:', event.id, error);
  }
  const tag = (name) => event.tags.find((entry) => entry[0] === name)?.[1];
  return {
    id: event.id,
    name: tag('title') || content.name || 'Item',
    description: content.description || '',
    price: tag('price') || content.price || '',
    currency: event.tags.find((entry) => entry[0] === 'price')?.[2] || content.currency || '',
    image: tag('image') || content.image || '',
  };
}

// The vendor's menu, open over the chat as a Sheet (not a full screen).
// Header carries the trust row; the grid and the sticky "Message vendor"
// ride the Sheet's own body and footer. Handlers are the pre-existing ones.
export default function VendorStorefront({ isOpen, onClose, vendorPubkey, profiles = {}, identity, onOpenChat, onBuy }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { vouchCount, loading: vouchesLoading } = useVouchCount({ identity, targetPubkey: vendorPubkey });
  const profile = profiles[vendorPubkey] || {};

  useEffect(() => {
    if (!isOpen || !vendorPubkey) return undefined;
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
        setProducts(events.map(parseListing).sort((a, b) => b.createdAt - a.createdAt));
      } catch (loadError) {
        console.error('[VendorStorefront] Vendor menu fetch failed:', loadError);
        if (active) setError('Could not load this vendor’s menu.');
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
  }, [isOpen, vendorPubkey]);

  const productName = noHexName(profile, vendorPubkey);
  const trusted = vouchCount >= 3;

  return (
    <Sheet
      open={isOpen && Boolean(vendorPubkey)}
      onClose={onClose}
      ariaLabel={`${productName} vendor menu`}
      stretch={false}
      footer={
        <Button
          size="lg"
          fullWidth
          leadingIcon={<MessageCircle size={17} />}
          onClick={() => {
            haptic('light');
            onOpenChat?.(vendorPubkey);
          }}
        >
          Message vendor
        </Button>
      }
    >
      <header className="glass-header sticky top-0 z-10 flex items-center gap-3 px-4 py-3">
        <Avatar
          src={profile.picture}
          name={productName}
          size={44}
          className={profile.picture ? '' : 'text-inkSubtle'}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-bold tracking-tight text-ink">{productName}</h2>
          <p className="flex items-center gap-1.5 text-[13px] text-inkMuted">
            <ShieldCheck size={15} className={trusted ? 'text-accentText' : 'text-inkSubtle'} aria-hidden="true" />
            {vouchesLoading ? 'Checking vouches…' : `${vouchCount} vouch${vouchCount === 1 ? '' : 'es'}${trusted ? ' · Trusted Vendor' : ''}`}
          </p>
        </div>
      </header>
      <div className="p-4">
        {error && <p role="alert" className="mb-3 rounded-2xl border border-line bg-panelStrong px-4 py-5 text-center text-[13px] text-danger">{error}</p>}
        {loading && <SkeletonGrid cols={4} />}
        {!loading && !error && products.length === 0 && (
          <EmptyState
            icon={<Store size={20} />}
            title="Nothing on the menu yet"
          >
            Check back later, or tap Message vendor below.
          </EmptyState>
        )}
        {!loading && products.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {products.map((product) => (
              <article key={product.id} className="overflow-hidden rounded-2xl border border-line bg-panelStrong">
                <Picture
                  src={product.image}
                  alt=""
                  loading="lazy"
                  className="aspect-[4/5] w-full border-b border-line object-cover"
                  fallback={<div className="flex aspect-[4/5] w-full items-center justify-center border-b border-line bg-panelAlt text-inkSubtle"><Package size={22} /></div>}
                />
                <div className="space-y-1 p-3">
                  <h3 className="line-clamp-2 min-h-[2.2em] text-[14px] font-semibold leading-snug text-ink">{product.name}</h3>
                  <p className="mono truncate text-[13px] font-semibold text-accentText">{product.price ? `${product.price} ${product.currency || ''}`.trim() : 'Ask'}</p>
                  {product.description && <p className="line-clamp-2 text-[12px] leading-snug text-inkMuted">{product.description}</p>}
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
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
