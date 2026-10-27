import React, { useState, useEffect } from 'react';
import { ORDER_STATUS } from './lib/paymentState';
import { Search, ChevronRight, ShoppingBag } from 'lucide-react';
import OneTapCheckout from './components/OneTapCheckout';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useChatStore } from './store/chatStore';
import { saveMessage } from './db';
import { haptic } from './lib/haptics';
import { copyText } from './lib/copyText';
import { generalRelays } from './lib/relays';
import { entryById } from './lib/egress';
import Picture from './components/ui/Picture';
import Avatar from './components/ui/Avatar';
import EmptyState from './components/ui/EmptyState';
import { pressable } from './components/ui/Button';
import { SkeletonGrid } from './components/ui/Skeleton';
import { listingFromEvent, orderProduct, priceLabel } from './lib/listing';
import { stampArrival } from './features/chat/media';
import { noHexName } from './lib/npub';

// The menus tab is a browse first: vendors on the network and the items
// they published, grouped per vendor. Entering a vendor's menu home is the
// drill-down — the header row of each section opens it. Whatever a poster
// published is what renders here (the app's own profile path); nothing on
// this screen is seeded.
//
// The footer carries the app's own install story, built only from the host
// list the app already declares (egress.js) — no invented URL.

const APP_HOST_URL = entryById('app-host')?.url || '';

function MenuTile({ item, onBuy, onCopyLink }) {
  return (
    <article className="rounded-3xl border border-line bg-panelStrong p-2">
      <div className="relative h-28 w-full overflow-hidden rounded-2xl bg-ink/5">
        <Picture
          src={item.image}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          fallback={<div className="flex h-full w-full items-center justify-center text-inkSubtle"><ShoppingBag size={28} /></div>}
        />
      </div>
      <div className="px-1.5 pb-1 pt-3">
        <p className="truncate text-[15px] font-semibold text-ink">{item.name}</p>
        <p className="text-[13px] font-bold text-accentText">{priceLabel(item.price, item.currency)}</p>
        <button
          type="button"
          onClick={() => { haptic('heavy'); onBuy?.(item); }}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-2xl bg-accent py-2 text-[13px] font-bold text-accentInk"
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => { haptic('light'); onCopyLink?.(item); }}
          className="mt-1 flex min-h-[44px] w-full items-center justify-center rounded-xl py-2 text-[12px] font-semibold text-ink/50"
        >
          Copy link
        </button>
      </div>
    </article>
  );
}

export default function Menus({ identity, setActiveTab }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Checkout lives in the chat store, not component state (fold from the
  // desktop lane's Shop change): a saved product link (?product=&vendor=)
  // sets it on boot, before this screen mounts, and the same field still
  // holds the screen's own Buy taps. The store is presentation-only state
  // here; no §0 selector was renamed.
  const checkoutProduct = useChatStore((s) => s.checkoutProduct);
  const setCheckoutProduct = useChatStore((s) => s.setCheckoutProduct);
  const profiles = useChatStore((state) => state.profiles);
  const { sendDM } = useNIP44DM({ identity });

  useEffect(() => {
    const fetchMarketplace = async () => {
      setLoading(true);
      setError('');
      try {
        const { SimplePool } = await import('nostr-tools');
        const pool = new SimplePool();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Network timeout')), 4000)
        );

        const fetchPromise = pool.querySync(
          generalRelays,
          { kinds: [30402], '#t': ['cipher_marketplace'], limit: 50 }
        );

        const events = await Promise.race([fetchPromise, timeoutPromise]);

        const parsed = events.map(listingFromEvent).filter((item) => Number(item.price) > 0);

        const unique = Array.from(new Map(parsed.map((item) => [item.id, item])).values());
        setProducts(unique);
        pool.close(generalRelays);
      } catch (fetchError) {
        console.error('Failed to fetch marketplace:', fetchError);
        setError('Could not load this menu. Check your connection and try again.');
      } finally {
        setLoading(false);
      }
    };

    fetchMarketplace();
  }, []);

  const shareProduct = async (product) => {
    const link = `${window.location.origin}${window.location.pathname}?product=${encodeURIComponent(product.id)}&vendor=${product.vendorPubkey}`;
    const ok = await copyText(link);
    return ok;
  };

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

  // The browse: the network's published items grouped per vendor. Search
  // matches a vendor's name or an item's; a section keeps only its matches.
  const queryText = query.trim().toLowerCase();
  const vendorRows = new Map();
  for (const item of products) {
    const vendor = String(item.vendorPubkey || '');
    if (!vendor) continue;
    const vendorName = noHexName(profiles[vendor], vendor).toLowerCase();
    const itemName = String(item.name || '').toLowerCase();
    if (queryText && !vendorName.includes(queryText) && !itemName.includes(queryText)) continue;
    if (!vendorRows.has(vendor)) vendorRows.set(vendor, []);
    vendorRows.get(vendor).push(item);
  }
  const sections = [...vendorRows.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="flex h-full w-full flex-col bg-transparent">
      <div className="px-4 pb-3 pt-2">
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-panelStrong px-4 py-3">
          <Search size={16} className="text-inkMuted" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-inkSubtle focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {loading && (
          <div className="mt-16 px-4">
            <SkeletonGrid cols={4} />
          </div>
        )}
        {!loading && error && (
          <div className="mx-4 mt-2 rounded-2xl border border-line bg-panel px-4 py-16 text-center">
            <p className="text-[15px] font-semibold text-ink">Menus unavailable</p>
            <p className="mt-1 text-[13px] text-ink/40">{error}</p>
          </div>
        )}
        {!loading && !error && sections.length === 0 && (
          <EmptyState icon={<ShoppingBag size={28} />} title="Nothing on the menu yet">
            Check back later, or open Discover to find vendors.
          </EmptyState>
        )}
        {!loading && sections.map(([vendor, items]) => {
          const vendorName = noHexName(profiles[vendor], vendor);
          return (
            <section key={vendor} className="mb-5">
              <button
                type="button"
                onClick={() => { haptic('light'); useChatStore.getState().setVendorStorefrontPubkey(vendor); }}
                aria-label={`Open ${vendorName}'s menu`}
                className={`flex min-h-[56px] w-full items-center justify-between px-4 py-2 text-left active:bg-ink/5 ${pressable}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar src={profiles[vendor]?.picture} name={vendorName} size={40} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold text-ink">{vendorName}</span>
                    <span className="block text-[12px] text-inkSubtle">
                      {items.length} {items.length === 1 ? 'item' : 'items'} on the menu
                    </span>
                  </span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-inkSubtle" aria-hidden="true" />
              </button>
              <div className="grid grid-cols-2 gap-3 px-4">
                {items.map((item) => (
                  <MenuTile
                    key={item.id}
                    item={item}
                    onBuy={(chosen) => setCheckoutProduct(chosen)}
                    onCopyLink={(chosen) => shareProduct(chosen)}
                  />
                ))}
              </div>
            </section>
          );
        })}
        <footer className="mt-2 border-t border-line px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
          <p className="text-center text-[12px] leading-relaxed text-inkSubtle">
            Cipher runs on this device.{' '}
            {APP_HOST_URL && (
              <a
                href={APP_HOST_URL}
                className="inline-flex min-h-[44px] min-w-[44px] items-center px-3 font-semibold text-accentText underline decoration-line"
                rel="noreferrer"
              >
                Get the app
              </a>
            )}
            <br />
            Run your own copy: serve the build (<code>npm run self-host</code>) and paste your mirror in Connections.
          </p>
        </footer>
      </div>
      {checkoutProduct && (
        <OneTapCheckout
          product={checkoutProduct}
          identity={identity}
          onConfirmOrder={confirmOrder}
          onClose={() => setCheckoutProduct(null)}
        />
      )}
    </div>
  );
}
