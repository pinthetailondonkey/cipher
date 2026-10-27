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
    <Sheet open={Boolean(editingProduct && product)} onClose={onClose} title="Edit listing">
      <form onSubmit={save} className="space-y-3 pb-3">
        <Input label="Name" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Input label="Price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
        <Textarea label="Note" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        <Input label="Image URL" value={image} onChange={(event) => setImage(event.target.value)} />
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <Button type="submit" fullWidth>Save listing</Button>
      </form>
    </Sheet>
  );
}
