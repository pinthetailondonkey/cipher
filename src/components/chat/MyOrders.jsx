import { CheckCircle2, Package } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import { orderState, orderHasVerifiedReceipt } from '../../lib/orderActions';

// The buyer's ledger: one timeline, newest first. Every row reads the same
// derived facts the order card in the thread reads (orderState — F7), so a
// claim the peer sent alone never upgrades a status; the ✓ marks an order
// with a countersigned receipt this device verified.
export default function MyOrders({ dms = {}, profiles = {}, onBack, onOpenChat, identity }) {
  const ownPubkey = identity?.pk;
  const orders = Object.entries(dms).flatMap(([vendorPubkey, messages]) => (
    messages
      .filter((message) => message.isSender && ['order_request', 'cipher_order'].includes(message.data?.type))
      .map((message) => ({
        message,
        vendorPubkey,
        state: orderState(messages, message.id, message, ownPubkey, vendorPubkey),
        countersigned: orderHasVerifiedReceipt(messages, message.id, message, ownPubkey, vendorPubkey),
      }))
  )).sort((a, b) => b.message.timestamp - a.message.timestamp);

  const statusTone = (status) => (
    status === 'completed' ? 'border-success text-success'
      : ['disputed', 'cancelled', 'refunded'].includes(status) ? 'border-danger text-danger'
        : 'border-accentText text-accentText'
  );

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-safe">
      <ScreenHeader title="My Orders" onBack={onBack} />
      {orders.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <Package size={28} className="mx-auto text-inkSubtle" />
          <h2 className="mt-3 text-[15px] font-semibold text-ink">No orders yet</h2>
          <p className="mt-1 text-[13px] text-inkMuted">Orders you place with vendors will appear here.</p>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-hidden">
            {orders.map(({ message, vendorPubkey, state, countersigned }) => {
              const product = message.data.product || message.data;
              return (
                <button type="button" key={message.id} onClick={() => onOpenChat?.(vendorPubkey)} className="flex min-h-[56px] w-full items-center gap-3 border-b border-line px-4 py-2 text-left last:border-0 active:bg-ink/5">
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
                      <span className="truncate text-[13px] text-inkMuted">{profiles[vendorPubkey]?.displayName || profiles[vendorPubkey]?.name || 'Seller'}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {countersigned && <CheckCircle2 size={14} className="text-success" aria-label="Countersigned receipt" />}
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusTone(state.status)}`}>{state.status.replaceAll('_', ' ')}</span>
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
