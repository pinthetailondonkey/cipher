import { useEffect, useState } from 'react';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Textarea from '../ui/Textarea';
import { isPrivateMedia } from '../../lib/mediaCrypto';

// The image field is two shapes. An attached photo is a private entry
// ({ url, key, iv, mime }) and stays one: seeded as the object, named on the
// sheet, and handed back whole on save — flattening it to a string keeps the
// URL but drops the key and the buyer's photo never opens again. A plain URL
// is a string and keeps the input it always had. Only typing replaces the
// photo, and only with a string.
//
// The listing the sheet was opened on still holds its entry while the URL box
// shows, so a misclick offers that photo back whole: closing the sheet used
// to be the only way, and the upload was already paid for.

export default function ProductEditModal({ editingProduct, onClose, onSubmit }) {
  const product = editingProduct?.msg?.data || editingProduct?.product || null;
  // The photo the listing arrived with, if it has one. It is what "Keep the
  // photo" restores; a plain-URL listing has nothing to offer back.
  const attached = isPrivateMedia(product?.image) ? product.image : null;
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setTitle(product?.title || product?.name || '');
    setPrice(String(product?.priceUsd ?? product?.price ?? ''));
    setDescription(product?.description || '');
    setPhoto(product?.image || null);
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
    // A typed URL is trimmed; a held entry is handed over untouched, so the
    // key and iv survive the edit.
    const image = isPrivateMedia(photo) ? photo : String(photo || '').trim();
    onSubmit?.({ title: title.trim(), priceUsd: amount, description: description.trim(), image });
  };

  return (
    <Sheet open={Boolean(editingProduct && product)} onClose={onClose} title="Edit listing">
      <form onSubmit={save} className="space-y-3 pb-3">
        <Input label="Name" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Input label="Price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
        <Textarea label="Note" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        <div className="flex items-center gap-3">
          {isPrivateMedia(photo) ? (
            <>
              <p className="min-w-0 flex-1 text-[13px] text-inkMuted">Photo attached</p>
              <Button variant="ghost" size="sm" onClick={() => setPhoto('')}>Use a URL</Button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <Input label="Image URL" value={photo || ''} onChange={(event) => setPhoto(event.target.value)} />
              </div>
              {attached && <Button variant="ghost" size="sm" onClick={() => setPhoto(attached)}>Keep the photo</Button>}
            </>
          )}
        </div>
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <Button type="submit" fullWidth>Save listing</Button>
      </form>
    </Sheet>
  );
}
