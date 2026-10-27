import { useEffect, useState } from 'react';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Textarea from '../ui/Textarea';

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
<<<<<<< HEAD
    <div className="fixed inset-0 z-sheet flex items-end justify-center bg-scrim/60 p-3" role="presentation" onClick={onClose}>
      <form role="dialog" aria-modal="true" aria-label="Edit listing" onClick={(event) => event.stopPropagation()} onSubmit={save} className="w-full max-w-sm space-y-4 rounded-3xl border border-line bg-panel p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-ink">Edit listing</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 text-inkMuted"><X size={18} /></button>
        </div>
        <div className="overflow-hidden rounded-2xl border border-line bg-panelStrong">
          <label className="flex items-center gap-3 border-b border-ink/5 p-4">
            <Type size={18} className="text-ink/40" />
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name" className="w-full bg-transparent text-[15px] text-ink outline-none" />
          </label>
          <label className="flex items-center gap-3 border-b border-ink/5 p-4">
            <Tag size={18} className="text-ink/40" />
            <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" placeholder="Price" className="w-full bg-transparent text-[15px] text-ink outline-none" />
          </label>
          <label className="flex items-center gap-3 border-b border-ink/5 p-4">
            <Type size={18} className="text-ink/40" />
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Note" className="w-full bg-transparent text-[15px] text-ink outline-none" />
          </label>
          <label className="flex items-center gap-3 p-4">
            <Image size={18} className="text-ink/40" />
            <input value={image} onChange={(event) => setImage(event.target.value)} placeholder="Image URL" className="w-full bg-transparent text-[15px] text-ink outline-none" />
          </label>
        </div>
=======
    <Sheet open={Boolean(editingProduct && product)} onClose={onClose} title="Edit listing">
      <form onSubmit={save} className="space-y-3 pb-3">
        <Input label="Name" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Input label="Price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
        <Textarea label="Note" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        <Input label="Image URL" value={image} onChange={(event) => setImage(event.target.value)} />
>>>>>>> origin/feat/rebuild-pr2
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <Button type="submit" fullWidth>Save listing</Button>
      </form>
    </Sheet>
  );
}
