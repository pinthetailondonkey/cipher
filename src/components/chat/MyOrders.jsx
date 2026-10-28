import { useState } from 'react';
import { CheckCircle2, Package, ReceiptText, Store } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import ReceiptInspect from './ReceiptInspect';
import { scopedGet } from '../../lib/storage';
import { haptic } from '../../lib/haptics';
import { orderState, orderHasVerifiedReceipt } from '../../lib/orderActions';
import { useChatStore } from '../../store/chatStore';

// The orders ledger: one timeline, newest first, read by both sides of the
// counter (15.1). A buyer sees the requests this device sent; a vendor sees
// the ones it received — the same isSender flip the wire's own direction
// flag gives, nothing new invented. Every row reads the same derived facts
// the order card in the thread reads (orderState — F7), so a claim the peer
// sent alone never upgrades a status; the ✓ marks an order with a
// countersigned receipt this device verified. The tab path passes no lists,
// so the store is the source there; Wallet still hands its props in.
export default function MyOrders({ dms = null, profiles = null, onBack, onOpenChat, onMenu, identity }) {
  const ownPubkey = identity?.pk;
  const storeDms = useChatStore((state) => state.dms);
  const storeProfiles = useChatStore((state) => state.profiles);
  const isVendor = useChatStore((state) => state.isVendor);
  const rows = dms || storeDms;
  const names = profiles || storeProfiles;
  // The one open receipt door at a time: the order event id the receipt is
  // filed under.
  const [receipt, setReceipt] = useState(null);
  const orders = Object.entries(rows).flatMap(([peerPubkey, messages]) => (
    messages
      .filter((message) => (isVendor ? !message.isSender : message.isSender) && ['order_request', 'cipher_order'].includes(message.data?.type))
      .map((message) => ({
        message,
        peerPubkey,
        state: orderState(messages, message.id, message, ownPubkey, peerPubkey),
        countersigned: orderHasVerifiedReceipt(messages, message.id, message, ownPubkey, peerPubkey),
      }))
  )).sort((a, b) => b.message.timestamp - a.message.timestamp);

  const statusTone = (status) => (
    status === 'completed' ? 'border-success text-success'
      : ['disputed', 'cancelled', 'refunded'].includes(status) ? 'border-danger text-danger'
        : 'border-accentText text-accentText'
  );

  return (
    <div className="h-full overflow-y-auto bg-transparent">
      <ScreenHeader title={isVendor ? 'Incoming Orders' : 'My Orders'} onBack={onBack} onMenu={onMenu} />
      {orders.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <Package size={28} className="mx-auto text-inkSubtle" />
          <h2 className="mt-3 text-[15px] font-semibold text-ink">No orders yet</h2>
          <p className="mt-1 text-[13px] text-inkMuted">{isVendor ? 'Orders buyers send you will appear here.' : 'Orders you place with vendors will appear here.'}</p>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-hidden">
            {orders.map(({ message, peerPubkey, state, countersigned }) => {
              const product = message.data.product || message.data;
              return (
                <div key={message.id} className="last:border-b-0 border-b border-line">
                  <button type="button" onClick={() => onOpenChat?.(peerPubkey)} className="flex min-h-[64px] w-full items-center gap-3 px-4 py-2 text-left active:bg-ink/5">
                    <Picture src={product.image} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-xl object-cover" fallback={<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-panelAlt text-inkMuted"><Package size={16} /></span>} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="block truncate text-[15px] font-semibold text-ink">{product.title || product.name || 'Order'}</span>
                        {message.timestamp && (
                          <span className="shrink-0 text-[11px] font-medium text-inkSubtle">
                            {new Date(message.timestamp * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] text-inkMuted">{names[peerPubkey]?.displayName || names[peerPubkey]?.name || (isVendor ? 'Buyer' : 'Seller')}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {countersigned && <CheckCircle2 size={14} className="text-success" aria-label="Countersigned receipt" />}
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusTone(state.status)}`}>{state.status.replaceAll('_', ' ')}</span>
                        </span>
                      </span>
                    </span>
                  </button>
                  {/* The menu door is the buyer's: it opens the seller's
                      storefront. On vendor rows the peer is a buyer — they
                      have no menu — so the door does not show. */}
                  {!isVendor && (
                    <button
                      type="button"
                      onClick={() => { haptic('light'); useChatStore.getState().setVendorStorefrontPubkey(peerPubkey); }}
                      className="flex min-h-[44px] w-full items-center gap-1.5 px-4 pb-1 text-[13px] font-semibold text-accentText"
                    >
                      <Store size={14} /> View menu
                    </button>
                  )}
                  {countersigned && (
                    <button
                      type="button"
                      onClick={() => { haptic('light'); setReceipt(message.id); }}
                      className="flex min-h-[44px] w-full items-center gap-1.5 px-4 pb-1 text-[13px] font-semibold text-accentText"
                    >
                      <ReceiptText size={14} /> View receipt
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <ReceiptInspect receipt={receipt ? scopedGet(`receipt_${receipt}`, null) : null} open={!!receipt} onClose={() => setReceipt(null)} />
    </div>
  );
}
