import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

function cipherOrder(product) {
  return {
    type: 'cipher_order',
    status: 'pending',
    vendorPubkey: product?.vendorPubkey || '',
    product: {
      id: product?.id || null,
      title: product?.name || product?.title || 'Product',
      name: product?.name || product?.title || 'Product',
      price: product?.priceUsd ?? product?.price ?? '',
      priceUsd: product?.priceUsd ?? product?.price ?? '',
      currency: product?.currency || 'USD',
      image: product?.image || '',
    },
  };
}

export default function OneTapCheckout({ product, onConfirmOrder, onClose }) {
  const [confirmed, setConfirmed] = useState(false);
  const [orderError, setOrderError] = useState('');
  const [copied, setCopied] = useState('');
  const order = cipherOrder(product);
  const amount = product?.price || (product?.priceUsd ? `$${product.priceUsd}` : '');
  const currency = product?.currency || 'USD';
  const addresses = [
    ['BTC', product?.btc],
    ['XMR', product?.xmr],
  ].filter(([, address]) => address);

  const copyAddress = async (label, address) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(label);
    } catch (error) {
      console.error('[OneTapCheckout] Could not copy address:', error);
      setOrderError('Could not copy that address.');
    }
  };

  const confirmOrder = async () => {
    if (confirmed) return;
    setConfirmed(true);
    setOrderError('');
    try {
      await onConfirmOrder?.(order);
    } catch (error) {
      console.error('[OneTapCheckout] Order confirmation failed:', error);
      setConfirmed(false);
      setOrderError(error?.message || 'Could not send your order request.');
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Checkout">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-white/10 bg-[#0A0A0A] p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-500">Step 1 of 2</p>
            <h2 className="text-xl font-bold text-white">Checkout</h2>
            <p className="mt-1 text-[13px] text-white/40">{product?.name || product?.title || 'Product'}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close checkout"><X size={20} /></button>
        </div>
        <p className="mb-1 text-[12px] text-white/40">Amount due</p>
        <p className="mb-4 text-[22px] font-bold text-white">{amount} {currency}</p>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-blue-500">Step 2 · Pay the seller</p>
        {addresses.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-[#111] p-4 text-[13px] leading-relaxed text-white/55">
            This seller has not published a public BTC or XMR address. Confirm sends the order in a private chat. Their payment address and QR code appear there after they accept.
          </p>
        ) : addresses.map(([label, address]) => (
          <div key={label} className="mb-3 rounded-xl border border-white/10 bg-[#111] p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-white">{label}</p>
              <button type="button" onClick={() => copyAddress(label, address)} className="flex items-center gap-1 text-[12px] font-semibold text-blue-500">
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
        <button type="button" onClick={confirmOrder} disabled={confirmed} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60">
          {confirmed ? <><Check size={17} /> Order sent to the seller</> : 'Confirm and message seller'}
        </button>
      </div>
    </div>
  );
}
