import { useState } from 'react';
import { ORDER_STATUS } from '../lib/paymentState';
import { Check, Loader2, X } from 'lucide-react';
import { orderProduct, priceLabel } from '../lib/listing';

function cipherOrder(product) {
  return {
    type: 'cipher_order',
    status: ORDER_STATUS.PENDING,
    vendorPubkey: product?.vendorPubkey || '',
    product: orderProduct(product),
  };
}

export default function OneTapCheckout({ product, onConfirmOrder, onClose }) {
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [orderError, setOrderError] = useState('');
  const order = cipherOrder(product);
  const amount = priceLabel(order.product.price, order.product.currency);

  const confirmOrder = async () => {
    if (confirmed || sending) return;
    setSending(true);
    setOrderError('');
    try {
      await onConfirmOrder?.(order);
      setConfirmed(true);
    } catch (error) {
      console.error('[OneTapCheckout] Order confirmation failed:', error);
      setOrderError(error?.message || 'Could not send your order request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-scrim/80 p-4" role="dialog" aria-modal="true" aria-label="Checkout">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-panel p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[13px] text-inkSubtle">Send this order in a private chat</p>
            <h2 className="text-2xl font-bold tracking-tight text-ink">Checkout</h2>
            <p className="mt-1 text-[13px] text-inkSubtle">{product?.name || product?.title || 'Product'}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-ink/50 hover:text-ink" aria-label="Close checkout"><X size={20} /></button>
        </div>
        <div className="mb-4 rounded-2xl border border-line bg-panelStrong p-4">
          <p className="text-[12px] text-inkSubtle">Amount due</p>
          <p className="font-mono text-[22px] font-bold text-ink">{amount}</p>
        </div>
        {/* The order is the only way to pay. No menu card shows a payment
            address or QR here: paying one directly skips the accept, the
            address issue, the chain check and the receipt, and the seller
            ships against their own accepted order only. (security S2) */}
        <p className="mb-3 rounded-xl border border-line bg-panelStrong p-4 text-[13px] leading-relaxed text-inkMuted">
          After the seller accepts, your payment address and QR code appear in the chat, on the accepted order. The order is the only way to pay — it is what ties the payment to a chain check.
        </p>
        {orderError && <p role="alert" className="mt-4 text-sm text-danger">{orderError}</p>}
        <button type="button" onClick={confirmOrder} disabled={confirmed || sending} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent disabled:opacity-60">
          {sending ? <><Loader2 size={17} className="animate-spin" /> Sending order…</> : confirmed ? <><Check size={17} /> Order sent. Pay in the chat.</> : 'Send order'}
        </button>
      </div>
    </div>
  );
}
