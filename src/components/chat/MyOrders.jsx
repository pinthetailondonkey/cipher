import { ArrowLeft, Package } from 'lucide-react';

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
    <div className="h-full overflow-y-auto pb-safe">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/5 bg-black/90 px-4 py-4 backdrop-blur-xl">
        <button type="button" onClick={onBack} className="touch-target -ml-2 p-2 text-white/50 hover:text-white" aria-label="Back to profile"><ArrowLeft size={20} /></button>
        <div>
          <h1 className="text-xl font-bold text-white">My Orders</h1>
          <p className="text-[13px] text-white/40">Your purchase conversations</p>
        </div>
      </header>
      {orders.length === 0 ? (
        <div className="flex flex-col items-center px-8 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-[#111] text-white/45"><Package size={24} /></span>
          <h2 className="mt-4 text-base font-semibold text-white">No orders yet</h2>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-white/45">Orders you place with vendors will appear here.</p>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {orders.map(({ message, vendorPubkey, update }) => {
            const product = message.data.product || message.data;
            const status = update?.data.status || message.data.status || 'pending';
            return (
              <button type="button" key={message.id} onClick={() => onOpenChat?.(vendorPubkey)} className="flex min-h-[84px] w-full items-center gap-3 px-4 py-4 text-left hover:bg-white/5">
                {product.image ? <img src={product.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-xl border border-white/10 object-cover" /> : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[#111] text-white/45"><Package size={19} /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">{product.title || product.name || 'Order'}</span>
                  <span className="mt-1 block truncate text-xs text-white/45">Vendor: {profiles[vendorPubkey]?.displayName || profiles[vendorPubkey]?.name || vendorPubkey.slice(0, 10)}</span>
                </span>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] capitalize text-white/65">{status.replaceAll('_', ' ')}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
