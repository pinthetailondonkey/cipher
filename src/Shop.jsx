import React, { useState, useEffect } from 'react';
import { ORDER_STATUS } from './lib/paymentState';
import { Search, ShoppingBag, Loader2 } from 'lucide-react';
import OneTapCheckout from './components/OneTapCheckout';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useChatStore } from './store/chatStore';
import { saveMessage } from './db';
import { haptic } from './lib/haptics';
import { copyText } from './lib/copyText';
import { generalRelays } from './lib/relays';
import Picture from './components/ui/Picture';
import { listingFromEvent, orderProduct, priceLabel } from './lib/listing';
import { stampArrival } from './features/chat/media';

export default function Shop({ identity, setActiveTab }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkoutProduct, setCheckoutProduct] = useState(null);
  const { sendDM } = useNIP44DM({ identity });

  useEffect(() => {
    const fetchMarketplace = async () => {
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
    };

    fetchMarketplace();
  }, []);

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
      {/* Desktop search bar: a flat full-width field like the chat list's,
          not a floating phone pill. */}
      <div className="px-3 pb-2 pt-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-panelAlt px-3 py-2.5">
          <Search size={18} className="flex-none text-ink/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the shop"
            className="flex-1 bg-transparent text-[14px] text-ink placeholder-ink/30 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="mt-20 flex flex-col items-center justify-center text-ink/40">
            <Loader2 size={32} className="mb-4 animate-spin text-accent" />
            <p className="text-sm">Fetching products from the network...</p>
          </div>
        ) : error ? (
          <div className="px-3">
            <p className="pt-10 text-center text-[15px] font-semibold text-ink">Shop unavailable</p>
            <p className="mt-1 pb-10 text-center text-[13px] text-ink/40">{error}</p>
          </div>
        ) : displayProducts.length === 0 ? (
          <div className="px-3">
            <p className="pt-10 pb-10 text-center text-[13px] text-ink/40">No products</p>
          </div>
        ) : (
          /* Desktop rows: full-width listing rows like chat list rows, not
              a phone card grid. Image left, name/price middle, actions right. */
          <div>
            {displayProducts.map(p => (
              <div
                key={p.id}
                className="mx-1.5 mb-0.5 flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-panelAlt"
                onClick={() => { haptic('heavy'); setCheckoutProduct(p); }}
              >
                <div className="h-14 w-14 flex-none overflow-hidden rounded-lg bg-ink/5">
                  <Picture
                    src={p.image}
                    alt=""
                    className="h-full w-full object-cover"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                    fallback={<div className="flex h-full w-full items-center justify-center text-ink/30"><ShoppingBag size={22} /></div>}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">{p.name}</p>
                  <p className="text-[13px] font-bold text-accent">{priceLabel(p.price, p.currency)}</p>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); haptic('heavy'); setCheckoutProduct(p); }}
                    className="rounded-lg bg-accent px-4 py-2 text-[13px] font-bold text-accentInk hover:brightness-110"
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); shareProduct(p); }}
                    className="rounded-lg px-3 py-2 text-[12px] font-semibold text-ink/50 hover:bg-ink/5 hover:text-ink/70"
                  >
                    Copy link
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {checkoutProduct && (
        <OneTapCheckout
          product={checkoutProduct}
          onConfirmOrder={confirmOrder}
          onClose={() => setCheckoutProduct(null)}
        />
      )}
    </div>
  );
}
