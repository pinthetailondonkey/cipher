import React, { useState, useEffect, useCallback } from 'react';
import { ORDER_STATUS } from './lib/paymentState';
import { Search, ShoppingBag, Share2 } from 'lucide-react';
import OneTapCheckout from './components/OneTapCheckout';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useChatStore } from './store/chatStore';
import { saveMessage } from './db';
import { haptic } from './lib/haptics';
import { copyText } from './lib/copyText';
import { generalRelays } from './lib/relays';
import Picture from './components/ui/Picture';
import EmptyState from './components/ui/EmptyState';
import { SkeletonGrid } from './components/ui/Skeleton';
import { listingFromEvent, orderProduct, priceLabel } from './lib/listing';
import { noHexName } from './lib/npub';
import { stampArrival } from './features/chat/media';

// One product card, §6: 4:5 image crop, vendor avatar 24 with display name
// bottom-left over the picture, name two lines, mono price in accent text,
// share in the corner, ghost Buy pill bottom-right. The card itself and the
// pill both open the checkout Sheet.
function ProductCard({ product, vendorName, vendorPicture, onOpen, onShare }) {
  const vendorInitial = (vendorName || '?').trim().slice(0, 1).toUpperCase() || '?';
  const openSheet = () => {
    haptic('heavy');
    onOpen(product);
  };
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-3xl border border-line bg-panelStrong shadow-lg">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Buy ${product.name}`}
        onClick={openSheet}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openSheet();
          }
        }}
        className="relative block aspect-[4/5] w-full cursor-pointer"
      >
        <Picture
          src={product.image}
          alt={product.name}
          className="h-full w-full object-cover"
          fallback={<div className="flex h-full w-full items-center justify-center bg-panelAlt text-ink/30"><ShoppingBag size={28} /></div>}
        />
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onShare(product); }}
          aria-label={`Share ${product.name}`}
          className="absolute right-1.5 top-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-scrim/55 text-ink backdrop-blur"
        >
          <Share2 size={15} />
        </button>
        <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-4.5rem)] items-center gap-1.5 rounded-full bg-scrim/55 py-0.5 pl-0.5 pr-2 backdrop-blur">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-panelStrong text-[10px] font-bold text-accentText">
            {vendorPicture
              ? <img src={vendorPicture} alt="" className="h-full w-full object-cover" />
              : vendorInitial}
          </span>
          <span className="truncate text-[11px] font-semibold text-ink">{vendorName || 'Vendor'}</span>
        </span>
      </div>
      <div className="flex items-end justify-between gap-2 p-2.5">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[14px] font-semibold text-ink">{product.name}</p>
          <p className="mt-0.5 font-mono text-[13px] text-accentText">{priceLabel(product.price, product.currency)}</p>
        </div>
        <button
          type="button"
          onClick={openSheet}
          className="flex min-h-[44px] shrink-0 items-center rounded-full border border-line bg-panel px-3.5 text-[13px] font-bold text-ink active:bg-ink/10"
        >
          Buy
        </button>
      </div>
    </div>
  );
}

export default function Shop({ identity, setActiveTab }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkoutProduct, setCheckoutProduct] = useState(null);
  const profiles = useChatStore((state) => state.profiles);
  const { sendDM } = useNIP44DM({ identity });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { SimplePool } = await import('nostr-tools');
      const pool = new SimplePool();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Relay timeout')), 4000)
      );

      const fetchPromise = pool.querySync(
        generalRelays,
        { kinds: [30402], '#t': ['cipher_marketplace'], limit: 50 }
      );

      const events = await Promise.race([fetchPromise, timeoutPromise]);

      const parsed = events.map(listingFromEvent).filter((p) => Number(p.price) > 0);

      const unique = Array.from(new Map(parsed.map(p => [p.id, p])).values());
      setProducts(unique);
      pool.close(generalRelays);
    } catch (err) {
      console.error('Failed to fetch marketplace:', err);
      setError('Could not load the shop. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shareProduct = async (product) => {
    const link = `${window.location.origin}${window.location.pathname}?product=${encodeURIComponent(product.id)}&vendor=${product.vendorPubkey}`;
    const ok = await copyText(link);
    if (!ok) return;
  };
  const displayProducts = products.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase())
  );

  const confirmOrder = async (order) => {
    const payload = order?.type === 'cipher_order' ? order : {
      type: 'cipher_order',
      status: ORDER_STATUS.PENDING,
      vendorPubkey: order?.vendorPubkey || '',
      product: orderProduct(order),
    };
    const vendorPubkey = payload.vendorPubkey;
    if (!identity?.sk || !vendorPubkey) throw new Error('Unlock your account to contact the seller.');
    if (vendorPubkey === identity.pk) throw new Error('You cannot place an order with yourself.');
    const tempId = `temp-${Date.now()}`;
    const optimistic = stampArrival({
      id: tempId,
      clientId: tempId,
      isSender: true,
      isGroup: false,
      pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      deliveryStatus: 'sending',
      data: payload,
    });
    useChatStore.getState().setDms((current) => ({
      ...current,
      [vendorPubkey]: [...(current[vendorPubkey] || []), optimistic],
    }));
    await saveMessage(vendorPubkey, optimistic);
    const result = await sendDM(vendorPubkey, payload, tempId);
    if (!result?.success) {
      useChatStore.getState().setDms((current) => ({
        ...current,
        [vendorPubkey]: (current[vendorPubkey] || []).filter((message) => message.clientId !== tempId),
      }));
      throw new Error(result?.error || 'The order request could not be sent.');
    }
    const confirmed = {
      ...optimistic,
      id: result.event?.id || tempId,
      timestamp: result.event?.created_at || optimistic.timestamp,
      deliveryStatus: result.queued ? 'queued' : 'sent',
    };
    await saveMessage(vendorPubkey, confirmed);
    useChatStore.getState().setDms((current) => ({
      ...current,
      [vendorPubkey]: (current[vendorPubkey] || []).map((message) => (
        message.clientId === tempId ? confirmed : message
      )),
    }));
    useChatStore.getState().openChat('dm', vendorPubkey);
    setCheckoutProduct(null);
    setActiveTab?.('chat');
  };

  return (
    <div className="flex h-full w-full flex-col bg-transparent">
      <div className="px-4 pb-3 pt-2">
        <div className="flex items-center gap-2 rounded-2xl border border-ink/15 bg-panelStrong px-4 py-3 shadow-lg">
          <Search size={16} className="text-ink/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent text-[15px] text-ink placeholder-ink/30 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="px-4 pt-1">
            <SkeletonGrid items={6} min={172} itemClass="h-64" />
          </div>
        ) : error ? (
          <div className="mx-4 rounded-2xl border border-line bg-panel px-4 py-16 text-center shadow-lg">
            <p className="text-[15px] font-semibold text-ink">Menu unavailable</p>
            <p className="mt-1 text-[13px] text-ink/40">{error}</p>
            <button
              type="button"
              onClick={() => { haptic('light'); load(); }}
              className="mt-4 inline-flex min-h-[44px] items-center rounded-full border border-line px-5 text-[13px] font-bold text-ink active:bg-ink/10"
            >
              Retry
            </button>
          </div>
        ) : displayProducts.length === 0 ? (
          query
            ? (
              <div className="mx-4 rounded-2xl border border-line bg-panel px-4 py-16 text-center shadow-lg">
                <ShoppingBag size={28} className="mx-auto mb-3 text-ink/30" />
                <p className="text-[15px] font-semibold text-ink">Nothing matches that</p>
                <p className="mt-1 text-[13px] text-ink/40">{query}</p>
              </div>
            )
            : (
              <EmptyState icon={ShoppingBag} title="No menus yet">
                You're early. Be the first menu on Cipher.
              </EmptyState>
            )
        ) : (
          <div className="grid gap-3 px-4 pb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))' }}>
            {displayProducts.map((product) => {
              const vendorProfile = profiles[product.vendorPubkey] || {};
              return (
                <ProductCard
                  key={product.id}
                  product={product}
                  vendorName={noHexName(vendorProfile, product.vendorPubkey)}
                  vendorPicture={vendorProfile.picture}
                  onOpen={setCheckoutProduct}
                  onShare={shareProduct}
                />
              );
            })}
          </div>
        )}
      </div>
      <OneTapCheckout
        product={checkoutProduct}
        open={!!checkoutProduct}
        onConfirmOrder={confirmOrder}
        onClose={() => setCheckoutProduct(null)}
      />
    </div>
  );
}
