import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

export default function ProductEditModal({ editingProduct, onClose, onSubmit }) {
  const product = editingProduct?.msg?.data || editingProduct?.product || null;
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setTitle(product?.title || product?.name || '');
    setPrice(String(product?.priceUsd ?? product?.price ?? ''));
    setDescription(product?.description || '');
    setImage(product?.image || '');
    setError('');
  }, [product]);

  if (!editingProduct || !product) return null;

  const save = (event) => {
    event.preventDefault();
    const amount = Number(price);
    if (!title.trim()) {
      setError('Add a name.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter a price greater than 0.');
      return;
    }
    onSubmit?.({ title: title.trim(), priceUsd: amount, description: description.trim(), image: image.trim() });
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 p-3" role="presentation" onClick={onClose}>
      <form role="dialog" aria-modal="true" aria-label="Edit listing" onClick={(event) => event.stopPropagation()} onSubmit={save} className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold text-white">Edit listing</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 text-white/50"><X size={18} /></button>
        </div>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name" className="w-full border-b border-white/5 bg-black px-1 py-3 text-[15px] text-white outline-none" />
        <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" placeholder="Price" className="w-full border-b border-white/5 bg-black px-1 py-3 text-[15px] text-white outline-none" />
        <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Note" className="w-full border-b border-white/5 bg-black px-1 py-3 text-[15px] text-white outline-none" />
        <input value={image} onChange={(event) => setImage(event.target.value)} placeholder="Image URL" className="w-full border-b border-white/5 bg-black px-1 py-3 text-[15px] text-white outline-none" />
        {error && <p role="alert" className="pt-3 text-[13px] text-red-400">{error}</p>}
        <button type="submit" className="mt-3 w-full py-3 text-left text-[15px] font-semibold text-blue-500">Save listing</button>
      </form>
    </div>
  );
}
