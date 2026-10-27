import { useEffect, useState } from 'react';
import { MessageCircle, Package, ShieldCheck } from 'lucide-react';
import Sheet from '../ui/Sheet';
import { useVouchCount } from '../../hooks/useVouchCount';
import { generalRelays } from '../../lib/relays';
import Picture from '../ui/Picture';
import Avatar from '../ui/Avatar';
import { noHexName } from '../../lib/npub';

function parseListing(event) {
  let content = {};
  try {
    content = JSON.parse(event.content || '{}');
  } catch (error) {
    console.warn('[VendorStorefront] Ignoring malformed listing:', event.id, error);
  }
  const tag = (name) => event.tags.find((entry) => entry[0] === name)?.[1];
  return {
    id: event.id,
    name: tag('title') || content.name || 'Product',
    description: content.description || '',
    price: tag('price') || content.price || '',
    currency: event.tags.find((entry) => entry[0] === 'price')?.[2] || content.currency || '',
    image: tag('image') || content.image || '',
  };
}

// The vendor surface, §7: a Sheet — avatar 44, name, vouch count with
// ShieldCheck, a 2-column grid of products, and a sticky full-width
// message-vendor action. All handlers stay external.
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
        console.error('[VendorStorefront] Listing fetch failed:', loadError);
        if (active) setError('Could not load this vendor’s listings.');
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

  return (
    <Sheet
      open={isOpen && !!vendorPubkey}
      onClose={onClose}
      label="Vendor menu"
      className="mx-auto max-w-md md:max-w-lg"
    >
      <header className="flex items-center gap-3 px-5 pb-4 pt-2">
        <div className="h-11 w-11 shrink-0">
          <Avatar src={profile.picture} name={noHexName(profile, vendorPubkey)} className="!h-11 !w-11 text-sm" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold text-ink">
            {noHexName(profile, vendorPubkey)}
          </h2>
          <p className="flex items-center gap-1 text-[13px] text-inkMuted">
            <ShieldCheck size={14} className={vouchCount >= 3 ? 'text-accentText' : 'text-ink/35'} />
            {vouchesLoading ? 'Checking trust' : `${vouchCount} vouches${vouchCount >= 3 ? ' · Trusted Vendor' : ''}`}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 px-5">
        {loading && <p className="rounded-2xl border border-line bg-panelStrong px-4 py-8 text-center text-[13px] text-inkMuted">Loading menu…</p>}
        {error && <p role="alert" className="rounded-2xl border border-line bg-panelStrong px-4 py-8 text-center text-[13px] text-danger">{error}</p>}
        {!loading && !error && products.length === 0 && <p className="rounded-2xl border border-line bg-panelStrong px-4 py-8 text-center text-[13px] text-inkMuted">Nothing on this menu yet.</p>}
        {!loading && !error && products.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {products.map((product) => (
              <article key={product.id} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panelStrong">
                <div className="aspect-square w-full overflow-hidden bg-ink/5">
                  <Picture
                    src={product.image}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    fallback={<div className="flex h-full w-full items-center justify-center text-ink/30"><Package size={28} /></div>}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2.5">
                  <h3 className="line-clamp-2 text-[14px] font-semibold text-ink">{product.name}</h3>
                  <p className="font-mono text-[13px] font-bold text-accentText">{product.price ? `${product.price} ${product.currency || ''}`.trim() : 'Ask'}</p>
                  {product.description && <p className="line-clamp-2 text-[12px] text-inkMuted">{product.description}</p>}
                  <button
                    type="button"
                    onClick={() => onBuy?.(product, vendorPubkey)}
                    className="mt-auto flex min-h-[44px] items-center justify-center rounded-full border border-line font-semibold text-ink active:bg-ink/10"
                  >
                    Buy
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Sticky bottom action: Message vendor, accent, full-width. */}
      <div className="sticky bottom-0 mt-4 border-t border-line bg-panel/95 px-5 pb-sheet pt-3 backdrop-blur">
        <button
          type="button"
          onClick={() => onOpenChat?.(vendorPubkey)}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-accent text-[15px] font-bold text-accentInk active:bg-accent"
        >
          <MessageCircle size={17} /> Message vendor
        </button>
      </div>
    </Sheet>
  );
}
