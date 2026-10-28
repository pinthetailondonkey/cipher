import { useState } from 'react';
import { ORDER_STATUS } from '../lib/paymentState';
import { deliveryMissMap, deliveryMisses, emptyDelivery, sealedNoteText, withFieldMiss } from '../lib/deliveryAddress';
import { createDeadDropNote } from '../lib/deadDrop';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays } from '../lib/relays';
import { Check, Loader2, ShoppingBag } from 'lucide-react';
import Sheet from './ui/Sheet';
import Picture from './ui/Picture';
import Input from './ui/Input';
import { orderProduct, priceLabel } from '../lib/listing';

// The order body carries a POINTER ONLY (Deal's carrier evaluation): the
// address itself is sealed into a burn-once dead-drop note at send time and
// the note's URL rides in `delivery.note`. The address never appears in the
// order body, any chat bubble, or any plaintext on the relays.
function cipherOrder(product, noteUrl) {
  return {
    type: 'cipher_order',
    status: ORDER_STATUS.PENDING,
    vendorPubkey: product?.vendorPubkey || '',
    product: orderProduct(product),
    delivery: { note: noteUrl },
  };
}

// The delivery-address fields, labels + hints from Money Moves' spec
// verbatim. Required until filled: nothing gates with a modal — tapping
// Send with an incomplete form paints the miss under the field.
const DELIVERY_FIELDS = [
  { field: 'name', label: 'Recipient', hint: 'whoever takes the delivery', inputMode: 'text', autoComplete: 'name' },
  { field: 'street', label: 'Street', hint: 'number, street, apartment or unit', inputMode: 'text', autoComplete: 'street-address' },
  { field: 'city', label: 'City', hint: '', inputMode: 'text', autoComplete: 'address-level2' },
  { field: 'state', label: 'State', hint: '', inputMode: 'text', autoComplete: 'address-level1' },
  { field: 'postalCode', label: 'Postal code', hint: 'exactly as your mail shows it', inputMode: 'text', autoComplete: 'postal-code' },
  { field: 'country', label: 'Country', hint: '', inputMode: 'text', autoComplete: 'country-name' },
];

// One delivery-field row: label, hint when it earns a place, the field, and
// the miss under it once this device has checked the shape.
function DeliveryField({ spec, value, miss, onChange, onBlur }) {
  const errorId = `delivery-${spec.field}-miss`;
  return (
    <div>
      <Input
        label={spec.label}
        labelFor={`delivery-${spec.field}`}
        id={`delivery-${spec.field}`}
        type="text"
        inputMode={spec.inputMode}
        autoComplete={spec.autoComplete}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        aria-describedby={miss ? errorId : undefined}
        aria-invalid={miss ? true : undefined}
        className={miss ? 'border-danger' : ''}
      />
      {spec.hint && !miss && <p className="mt-1 text-[12px] text-inkSubtle">{spec.hint}</p>}
      {miss && <p id={errorId} className="mt-1 text-[12px] text-danger">{miss}</p>}
    </div>
  );
}

// One tap from the menu. Every surface that hands over a product opens
// checkout as the Sheet; §4 anatomy: image, title, price, payment block,
// actions.
export default function OneTapCheckout({ product, open = true, onConfirmOrder, onClose, identity }) {
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [orderError, setOrderError] = useState('');
  // The required delivery address: incomplete until filled, checked by
  // shape only (deliveryAddress.js — no third-party lookup ever).
  const [delivery, setDelivery] = useState(() => emptyDelivery());
  const [misses, setMisses] = useState({});
  const order = cipherOrder(product, '');
  const amount = priceLabel(order.product.price, order.product.currency);
  const title = order.product.title;
  const image = product?.image || '';

  const confirmOrder = async () => {
    if (confirmed || sending) return;
    // Send is the one moment every required field speaks at once.
    const map = deliveryMissMap(delivery);
    setMisses(map);
    if (deliveryMisses(delivery).length) return; // the misses under the fields are the gate
    setSending(true);
    setOrderError('');
    try {
      // Seal the address into a burn-once note; the order carries only the
      // note's URL. If no relay takes the note, nothing is sent at all.
      const pool = await getAuthenticatedPool(identity);
      const { url } = await createDeadDropNote({
        identity,
        text: sealedNoteText(delivery),
        pool,
        relays: generalRelays,
      });
      await onConfirmOrder?.(cipherOrder(product, url));
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
      bodyClassName="max-h-[68vh] overflow-y-auto"
    >
      <div className="space-y-4">
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
        {/* The delivery address. Words are Money Moves' spec verbatim: the
            top breath is two lines, hints sit under their labels, the miss
            lines are short and blame-free. Required before the order can be
            placed, checked by shape only on this device; the address itself
            travels sealed in a burn-once note, the order carries its URL. */}
        <div className="space-y-3 pt-1">
          <p className="text-[13px] leading-relaxed text-inkMuted">
            Your address goes to the vendor once, sealed — never into the chat,
            <br />
            never off your phone any other way. The note will not open again on their phone.
          </p>
          {DELIVERY_FIELDS.map((spec) => (
            <DeliveryField
              key={spec.field}
              spec={spec}
              value={delivery[spec.field]}
              miss={misses[spec.field]}
              onChange={(event) => {
                const next = { ...delivery, [spec.field]: event.target.value };
                setDelivery(next);
                // Typing may clear or update this field's own line. A field
                // that has not spoken yet stays quiet — the others never
                // light up from a keystroke.
                setMisses((current) => (
                  spec.field in current ? withFieldMiss(current, next, spec.field) : current
                ));
              }}
              onBlur={() => setMisses((current) => withFieldMiss(current, delivery, spec.field))}
            />
          ))}
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
      <div className="px-0 pt-5">
        <button
          type="button"
          onClick={confirmOrder}
          disabled={confirmed || sending}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-accent font-bold text-accentInk active:bg-accent disabled:opacity-60"
        >
          {sending ? <><Loader2 size={17} className="animate-spin" /> Sealing…</> : confirmed ? <><Check size={17} /> Sealed. Only the vendor can open it.</> : 'Seal and send'}
        </button>
        <p className="pt-2 text-center text-[12px] leading-relaxed text-inkSubtle">
          Cipher checks the shape of it, not the address. That part is between you and the mail.
        </p>
      </div>
    </Sheet>
  );
}
