import { useState } from 'react';
import { ORDER_STATUS } from '../lib/paymentState';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { copyText } from '../lib/copyText';
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
  const [copied, setCopied] = useState('');
  const order = cipherOrder(product);
  const amount = priceLabel(order.product.price, order.product.currency);
  const addresses = [
    ['BTC', product?.btc],
    ['XMR', product?.xmr],
  ].filter(([, address]) => address);

  const copyAddress = async (label, address) => {
    try {
      const ok = await copyText(address);
      if (ok) setCopied(label);
    } catch (error) {
      console.error('[OneTapCheckout] Could not copy address:', error);
      setOrderError('Could not copy that address.');
    }
  };

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
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Checkout">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-panel p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[13px] text-white/40">Send this order in a private chat</p>
            <h2 className="text-2xl font-bold tracking-tight text-white">Checkout</h2>
            <p className="mt-1 text-[13px] text-white/40">{product?.name || product?.title || 'Product'}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close checkout"><X size={20} /></button>
        </div>
        <div className="mb-4 rounded-2xl border border-line bg-panelStrong shadow-lg p-4">
          <p className="text-[12px] text-white/40">Amount due</p>
          <p className="text-[22px] font-bold text-white">{amount}</p>
        </div>
        <p className="mb-3 text-[13px] text-white/40">{addresses.length ? 'These are the seller’s published addresses. They may send a fresh one in the chat after they accept.' : 'The seller sends a payment address in the chat after they accept.'}</p>
        {addresses.length === 0 ? (
          <p className="rounded-xl border border-line bg-panelStrong shadow-lg p-4 text-[13px] leading-relaxed text-white/55">
            This seller has not published a public BTC or XMR address. Confirm sends the order in a private chat. Their payment address and QR code appear there after they accept.
          </p>
        ) : addresses.map(([label, address]) => (
          <div key={label} className="mb-3 rounded-xl border border-line bg-panelStrong shadow-lg p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-white">{label}</p>
              <button type="button" onClick={() => copyAddress(label, address)} className="flex items-center gap-1 text-[12px] font-semibold text-accent">
                <Copy size={13} /> {copied === label ? 'Copied!' : 'Copy Address'}
              </button>
            </div>
            <div className="mb-2 flex justify-center rounded-xl bg-white p-3">
              <QRCodeSVG value={address} size={148} level="M" />
            </div>
            <p className="break-all font-mono text-[11px] text-white/70">{address}</p>
          </div>
        ))}
        {orderError && <p role="alert" className="mt-4 text-sm text-red-400">{orderError}</p>}
        <button type="button" onClick={confirmOrder} disabled={confirmed || sending} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent disabled:opacity-60">
          {sending ? <><Loader2 size={17} className="animate-spin" /> Sending order…</> : confirmed ? <><Check size={17} /> Order sent. Pay in the chat.</> : 'Send order'}
        </button>
      </div>
    </div>
  );
}
