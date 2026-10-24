import React, { useState, useEffect } from 'react';
import { Search, ShoppingBag, Loader2 } from 'lucide-react';
import OneTapCheckout from './components/OneTapCheckout';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useChatStore } from './store/chatStore';
import { saveMessage } from './db';
import { haptic } from './lib/haptics';
import { copyText } from './lib/copyText';

export default function Shop({ identity, setActiveTab }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checkoutProduct, setCheckoutProduct] = useState(null);
  const { sendDM } = useNIP44DM({ identity });

  useEffect(() => {
    const fetchMarketplace = async () => {
      setLoading(true);
      try {
        const { SimplePool } = await import('nostr-tools');
        const pool = new SimplePool();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Relay timeout')), 4000)
        );

        const fetchPromise = pool.querySync(
          ['wss://relay.primal.net', 'wss://groups.aegispayhq.com'],
          { kinds: [30402], '#t': ['cipher_marketplace'], limit: 50 }
        );

        const events = await Promise.race([fetchPromise, timeoutPromise]);

        const parsed = events.map(ev => {
          const getTag = (name) => ev.tags.find(t => t[0] === name)?.[1];
          const payments = ev.tags.filter((tag) => tag[0] === 'payment').map((tag) => tag[1] || '');
          return {
            id: getTag('d') || ev.id,
            name: getTag('title') || 'Unnamed Product',
            priceUsd: parseFloat(getTag('price') || '0'),
            price: `$${parseFloat(getTag('price') || '0')}`,
            currency: getTag('price') ? (ev.tags.find((tag) => tag[0] === 'price')?.[2] || 'USD') : 'USD',
            image: getTag('image') || '',
            vendorPubkey: ev.pubkey,
            btc: payments.find((value) => value.startsWith('btc:'))?.slice(4) || '',
            xmr: payments.find((value) => value.startsWith('xmr:'))?.slice(4) || '',
          };
        }).filter(p => p.priceUsd > 0);

        const unique = Array.from(new Map(parsed.map(p => [p.id, p])).values());
        setProducts(unique);
        pool.close(['wss://relay.primal.net', 'wss://groups.aegispayhq.com']);
      } catch (err) {
        console.error('Failed to fetch marketplace:', err);
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
      status: 'pending',
      vendorPubkey: order?.vendorPubkey || '',
      product: {
        id: order?.id,
        title: order?.name || order?.title || 'Product',
        name: order?.name || order?.title || 'Product',
        price: order?.priceUsd ?? order?.price ?? '',
        priceUsd: order?.priceUsd ?? order?.price ?? '',
        currency: 'USD',
        image: order?.image || '',
      },
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
    <div className="flex h-full w-full flex-col bg-black">
      <div className="border-b border-white/5 px-4 py-3">
        <h1 className="text-[17px] font-semibold text-white">Shop</h1>
      </div>

      <div className="border-b border-white/5 bg-black px-4">
        <div className="flex items-center gap-2 py-3">
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

      <div className="flex-1 overflow-y-auto pb-24">
        {loading ? (
          <div className="mt-20 flex flex-col items-center justify-center text-white/40">
            <Loader2 size={32} className="mb-4 animate-spin text-blue-500" />
            <p className="text-sm">Fetching products from the network...</p>
          </div>
        ) : displayProducts.length === 0 ? (
          <div className="mt-20 text-center text-white/30">
            <ShoppingBag size={48} className="mx-auto mb-4 opacity-50" />
            <p>No products found</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-px bg-white/10">
            {displayProducts.map(p => (
              <div key={p.id} className="flex flex-col bg-black">
                <div className="relative h-28 w-full overflow-hidden bg-[#111]">
                  {p.image ? (
                    <img src={p.image} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-white/20">
                      <ShoppingBag size={28} />
                    </div>
                  )}
                </div>
                <div className="px-3 py-2">
                  <p className="truncate text-[15px] font-semibold text-white">{p.name}</p>
                  <p className="text-[13px] font-bold text-blue-500">${p.priceUsd}</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => shareProduct(p)} className="text-[13px] font-semibold text-white/50 active:text-white">Copy</button>
                    <button type="button" onClick={() => { haptic('heavy'); setCheckoutProduct(p); }} className="text-[13px] font-semibold text-blue-500 active:text-blue-400">Buy</button>
                  </div>
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
