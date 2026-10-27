import { useState } from 'react';
import { ORDER_STATUS } from '../lib/paymentState';
import { Check, Loader2, ShoppingBag } from 'lucide-react';
import Sheet from './ui/Sheet';
import Picture from './ui/Picture';
import { orderProduct, priceLabel } from '../lib/listing';

function cipherOrder(product) {
  return {
    type: 'cipher_order',
    status: ORDER_STATUS.PENDING,
    vendorPubkey: product?.vendorPubkey || '',
    product: orderProduct(product),
  };
}

// One tap from the menu. Every surface that hands over a product opens
// checkout as the Sheet; §4 anatomy: image, title, price, payment block,
// actions.
export default function OneTapCheckout({ product, open = true, onConfirmOrder, onClose }) {
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [orderError, setOrderError] = useState('');
  const order = cipherOrder(product);
  const amount = priceLabel(order.product.price, order.product.currency);
  const title = order.product.title;
  const image = product?.image || '';

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
    <Sheet
      open={open !== false && !!product}
      onClose={onClose}
      heading="Checkout"
      label={title ? `Checkout — ${title}` : 'Checkout'}
    >
      <div className="space-y-4 px-5 pt-4">
        <div className="flex items-start gap-3">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-line bg-panelStrong">
            <Picture
              src={image}
              alt={title}
              className="h-full w-full object-cover"
              fallback={<div className="flex h-full w-full items-center justify-center text-ink/30"><ShoppingBag size={26} /></div>}
            />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] text-inkSubtle">Send this order in a private chat</p>
            <h3 className="mt-0.5 text-[15px] font-semibold text-ink">{title}</h3>
            <p className="mt-1 font-mono text-[13px] font-bold text-accentText">{amount}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-panelStrong p-4">
          <p className="text-[12px] text-inkSubtle">Amount due</p>
          <p className="font-mono text-[22px] font-bold text-ink">{amount}</p>
        </div>
        {/* The order is the only way to pay. No menu card shows a payment
            address or QR here: paying one directly skips the accept, the
            address issue, the chain check and the receipt, and the seller
            ships against their own accepted order only. (security S2) */}
        <p className="rounded-xl border border-line bg-panelStrong p-4 text-[13px] leading-relaxed text-inkMuted">
          After the seller accepts, your payment address and QR code appear in the chat, on the accepted order. The order is the only way to pay — it is what ties the payment to a chain check.
        </p>
        {orderError && <p role="alert" className="text-sm text-danger">{orderError}</p>}
      </div>
      <div className="px-5 pt-5">
        <button
          type="button"
          onClick={confirmOrder}
          disabled={confirmed || sending}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-accent font-bold text-accentInk active:bg-accent disabled:opacity-60"
        >
          {sending ? <><Loader2 size={17} className="animate-spin" /> Sending order…</> : confirmed ? <><Check size={17} /> Order sent. Pay in the chat.</> : 'Send order'}
        </button>
      </div>
    </Sheet>
  );
}
