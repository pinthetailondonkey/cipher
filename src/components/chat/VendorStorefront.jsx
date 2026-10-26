import { useEffect, useState } from 'react';
import { BadgeCheck, MessageCircle, Package, Store, X } from 'lucide-react';
import { useVouchCount } from '../../hooks/useVouchCount';
import { generalRelays } from '../../lib/relays';
import Picture from '../ui/Picture';
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

  if (!isOpen || !vendorPubkey) return null;

  return (
    <div className="fixed inset-0 z-[900] flex items-end justify-center bg-scrim/80 p-0 sm:items-center sm:p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Vendor storefront" className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-line bg-panel pb-[env(safe-area-inset-bottom)] sm:rounded-3xl">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-ink/5 bg-base px-4 py-4 pt-[env(safe-area-inset-top)]">
          <Picture src={profile.picture} alt="" className="h-12 w-12 rounded-full border border-ink/10 object-cover" fallback={<div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-panelStrong shadow-lg text-ink/50"><Store size={20} /></div>} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink">{noHexName(profile, vendorPubkey)}</h2>
            <p className="flex items-center gap-1 text-[13px] text-ink/45"><BadgeCheck size={14} className={vouchCount >= 3 ? 'text-accent' : ''} />{vouchesLoading ? 'Checking trust' : `${vouchCount} vouches${vouchCount >= 3 ? ' · Trusted Vendor' : ''}`}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close storefront" className="p-2 text-ink/45 hover:text-ink"><X size={20} /></button>
        </header>
        <div className="space-y-3 p-4">
        <button type="button" onClick={() => onOpenChat?.(vendorPubkey)} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent"><MessageCircle size={17} /> Message vendor</button>
        {loading && <p className="rounded-2xl border border-line bg-panelStrong shadow-lg px-4 py-8 text-center text-[13px] text-ink/40">Loading listings…</p>}
        {error && <p role="alert" className="rounded-2xl border border-line bg-panelStrong shadow-lg px-4 py-8 text-center text-[13px] text-red-400">{error}</p>}
        {!loading && !error && products.length === 0 && <p className="rounded-2xl border border-line bg-panelStrong shadow-lg px-4 py-8 text-center text-[13px] text-ink/40">No active listings.</p>}
        {products.length > 0 && <div className="overflow-hidden rounded-2xl border border-line bg-panelStrong shadow-lg">
        {products.map((product) => (
          <article key={product.id} className="flex items-center gap-3 border-b border-ink/5 p-4 last:border-0">
            <Picture src={product.image} alt="" loading="lazy" className="h-12 w-12 rounded-xl border border-ink/10 object-cover" fallback={<div className="flex h-12 w-12 items-center justify-center rounded-xl border border-ink/10 bg-scrim text-ink/40"><Package size={18} /></div>} />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold text-ink">{product.name}</h3>
              <p className="text-[13px] font-semibold text-accent">{product.price ? `${product.price} ${product.currency || ''}`.trim() : 'Ask'}</p>
              {product.description && <p className="truncate text-[13px] text-ink/40">{product.description}</p>}
            </div>
            <button type="button" onClick={() => onBuy?.(product, vendorPubkey)} className="rounded-2xl bg-accent px-4 py-2 text-[13px] font-bold text-accentInk hover:bg-accent">Buy</button>
          </article>
        ))}
        </div>}
        </div>
      </section>
    </div>
  );
}
