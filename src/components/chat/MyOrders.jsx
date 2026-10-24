import { Package } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';

export default function MyOrders({ dms = {}, profiles = {}, onBack, onOpenChat }) {
  const orders = Object.entries(dms).flatMap(([vendorPubkey, messages]) => {
    const updates = messages.filter((message) => message.data?.type === 'order_update');
    return messages
      .filter((message) => message.isSender && ['order_request', 'cipher_order'].includes(message.data?.type))
      .map((message) => {
        const update = updates
          .filter((item) => item.data.orderId === message.id || item.data.orderId === message.clientId)
          .sort((a, b) => b.timestamp - a.timestamp)[0];
        return { message, vendorPubkey, update };
      });
  }).sort((a, b) => b.message.timestamp - a.message.timestamp);

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-safe">
      <ScreenHeader title="My Orders" onBack={onBack} />
      {orders.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <Package size={28} className="mx-auto text-white/30" />
          <h2 className="mt-3 text-[15px] font-semibold text-white">No orders yet</h2>
          <p className="mt-1 text-[13px] text-white/40">Orders you place with vendors will appear here.</p>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
          {orders.map(({ message, vendorPubkey, update }) => {
            const product = message.data.product || message.data;
            const status = update?.data.status || message.data.status || 'pending';
            return (
              <button type="button" key={message.id} onClick={() => onOpenChat?.(vendorPubkey)} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5">
                {product.image ? <img src={product.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-xl object-cover" /> : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-black text-white/40"><Package size={18} /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">{product.title || product.name || 'Order'}</span>
                  <span className="block truncate text-[13px] text-white/40">{profiles[vendorPubkey]?.displayName || profiles[vendorPubkey]?.name || 'Seller'}</span>
                </span>
                <span className="text-[13px] capitalize text-blue-500">{status.replaceAll('_', ' ')}</span>
              </button>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}
