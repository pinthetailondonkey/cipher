import { useState } from 'react';
import { CheckCircle2, Package, ReceiptText, Store } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import ReceiptInspect from './ReceiptInspect';
import { scopedGet } from '../../lib/storage';
import { haptic } from '../../lib/haptics';
import { orderState, orderHasVerifiedReceipt } from '../../lib/orderActions';
import { useChatStore } from '../../store/chatStore';
import { defaultLedgerSide, orderRows, peerRole } from '../../lib/orderLedger';

// The orders ledger: one timeline, newest first, read by both sides of the
// counter (15.1). A buyer sees the requests this device sent; a vendor sees
// the ones it received — the same isSender flip the wire's own direction
// flag gives, nothing new invented. Every row reads the same derived facts
// the order card in the thread reads (orderState — F7), so a claim the peer
// sent alone never upgrades a status; the ✓ marks an order with a
// countersigned receipt this device verified. The tab path passes no lists,
// so the store is the source there; Wallet still hands its props in.
//
// The view is this screen's own choice: a vendor opens on the orders received
// and can still read the orders they placed. A vendor who buys keeps both
// ledgers, and switching between them touches neither vendor mode nor the
// payment settings behind it.
const LEDGER_VIEWS = [
  { id: 'incoming', label: 'Incoming' },
  { id: 'purchases', label: 'Purchases' },
];

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
  const [side, setSide] = useState(() => defaultLedgerSide(isVendor));
  const orders = orderRows(rows, { side }).map(({ message, peerPubkey, isBuyer }) => ({
    message,
    peerPubkey,
    isBuyer,
    state: orderState(rows[peerPubkey], message.id, message, ownPubkey, peerPubkey),
    countersigned: orderHasVerifiedReceipt(rows[peerPubkey], message.id, message, ownPubkey, peerPubkey),
  }));
  const incoming = side === 'incoming';

  const statusTone = (status) => (
    status === 'completed' ? 'border-success text-success'
      : ['disputed', 'cancelled', 'refunded'].includes(status) ? 'border-danger text-danger'
        : 'border-accentText text-accentText'
  );

  return (
    <div className="h-full overflow-y-auto bg-transparent">
      <ScreenHeader title={incoming ? 'Incoming Orders' : 'My Orders'} onBack={onBack} onMenu={onMenu} />
      <div className="px-4 pt-3">
        <div className="grid grid-cols-2 rounded-xl border border-line p-1" role="tablist" aria-label="Orders ledger">
          {LEDGER_VIEWS.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={side === view.id}
              onClick={() => { haptic('light'); setSide(view.id); }}
              className={`min-h-[44px] rounded-lg py-2 text-[13px] font-bold ${side === view.id ? 'bg-accent text-accentInk' : 'text-inkMuted'}`}
            >
              {view.label}
            </button>
          ))}
        </div>
      </div>
      {orders.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <Package size={28} className="mx-auto text-inkSubtle" />
          <h2 className="mt-3 text-[15px] font-semibold text-ink">No orders yet</h2>
          <p className="mt-1 text-[13px] text-inkMuted">{incoming ? 'Orders buyers send you will appear here.' : 'Orders you place with vendors will appear here.'}</p>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-hidden">
            {orders.map(({ message, peerPubkey, isBuyer, state, countersigned }) => {
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
                        <span className="truncate text-[13px] text-inkMuted">{names[peerPubkey]?.displayName || names[peerPubkey]?.name || peerRole(isBuyer)}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {countersigned && <CheckCircle2 size={14} className="text-success" aria-label="Countersigned receipt" />}
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusTone(state.status)}`}>{state.status.replaceAll('_', ' ')}</span>
                        </span>
                      </span>
                    </span>
                  </button>
                  {/* The menu door is the buyer's: it opens the seller's
                      menu. On incoming rows the peer is a buyer — they have
                      no menu — so the door does not show. The row's own
                      direction says which is which, not the mode. */}
                  {isBuyer && (
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
