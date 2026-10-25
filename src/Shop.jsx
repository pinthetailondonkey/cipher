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
    const optimistic = {
      id: tempId,
      clientId: tempId,
      isSender: true,
      isGroup: false,
      pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      deliveryStatus: 'sending',
      data: payload,
    };
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
        <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 shadow-2xl backdrop-blur-2xl">
          <Search size={16} className="text-white/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent text-[15px] text-white placeholder-white/30 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="mt-20 flex flex-col items-center justify-center text-white/40">
            <Loader2 size={32} className="mb-4 animate-spin text-blue-500" />
            <p className="text-sm">Fetching products from the network...</p>
          </div>
        ) : error ? (
          <div className="mx-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl">
            <p className="text-[15px] font-semibold text-white">Shop unavailable</p>
            <p className="mt-1 text-[13px] text-white/40">{error}</p>
          </div>
        ) : displayProducts.length === 0 ? (
          <div className="mx-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl">
            <ShoppingBag size={28} className="mx-auto mb-3 text-white/30" />
            <p className="text-[15px] font-semibold text-white">No products</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 px-4 pb-4">
            {displayProducts.map(p => (
              <div key={p.id} className="rounded-3xl border border-white/15 bg-white/10 p-2 shadow-2xl backdrop-blur-2xl">
                <div className="relative h-28 w-full overflow-hidden rounded-2xl bg-white/5">
                  <Picture
                    src={p.image}
                    alt=""
                    className="h-full w-full object-cover"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                    fallback={<div className="flex h-full w-full items-center justify-center text-white/30"><ShoppingBag size={28} /></div>}
                  />
                </div>
                <div className="px-1.5 pb-1 pt-3">
                  <p className="truncate text-[15px] font-semibold text-white">{p.name}</p>
                  <p className="text-[13px] font-bold text-blue-400">{priceLabel(p.price, p.currency)}</p>
                  <button type="button" onClick={() => { haptic('heavy'); setCheckoutProduct(p); }} className="mt-3 w-full rounded-2xl bg-blue-600 py-2.5 text-[13px] font-bold text-white shadow-lg">Buy</button>
                  <button type="button" onClick={() => shareProduct(p)} className="mt-1 w-full py-1 text-[12px] font-semibold text-white/50">Copy link</button>
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
