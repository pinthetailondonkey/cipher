import { useState } from 'react';
import { Check, X } from 'lucide-react';

export default function OneTapCheckout({ product, onConfirmOrder, onClose }) {
  const [confirmed, setConfirmed] = useState(false);
  const [orderError, setOrderError] = useState('');

  const confirmOrder = async () => {
    if (confirmed) return;
    setConfirmed(true);
    setOrderError('');
    try {
      await onConfirmOrder?.(product);
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
            <h2 className="text-xl font-bold text-white">Checkout</h2>
            <p className="mt-1 text-[13px] text-white/40">{product?.name || 'Product'}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close checkout"><X size={20} /></button>
        </div>
        <p className="mb-5 text-[15px] font-semibold text-white">{product?.price || ''} {product?.currency || ''}</p>
        <p className="rounded-xl border border-white/10 bg-[#111] p-4 text-[13px] leading-relaxed text-white/55">
          This sends an encrypted order request to the seller. Payment details and a fresh order-specific BTC/XMR address will appear in your private chat after the seller accepts.
        </p>
        {orderError && <p role="alert" className="mt-4 text-sm text-red-400">{orderError}</p>}
        <button type="button" onClick={confirmOrder} disabled={confirmed} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60">
          {confirmed ? <><Check size={17} /> Order request sent</> : 'Send order request'}
        </button>
      </div>
    </div>
  );
}
