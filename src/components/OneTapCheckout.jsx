import { useState } from 'react';
import { ORDER_STATUS } from '../lib/paymentState';
import { deliveryMissMap, deliveryMisses, emptyDelivery, sealedNoteText, withFieldMiss } from '../lib/deliveryAddress';
import { createDeadDropNote } from '../lib/deadDrop';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays } from '../lib/relays';
import { useProfiles } from '../useProfiles';
import { Loader2, MessageCircle, ShoppingBag } from 'lucide-react';
import Sheet from './ui/Sheet';
import Picture from './ui/Picture';
import Input from './ui/Input';
import Avatar from './ui/Avatar';
import { pushToast } from './ui/toast';
import { useChatStore } from '../store/chatStore';
import { noHexName } from '../lib/npub';
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
export default function OneTapCheckout({ product, open = true, onConfirmOrder, onJumpToChat, onClose, identity }) {
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
  // The confirmation card names the person the order went to. The store map
  // answers immediately for a vendor this device already knows; the same
  // profile hook the profile card uses fills a cold open over the relays.
  const vendorPubkey = product?.vendorPubkey || '';
  const vendorStored = useChatStore((state) => (vendorPubkey ? state.profiles[vendorPubkey] : undefined));
  const vendorFetched = useProfiles(vendorPubkey ? [vendorPubkey] : []);
  const vendorProfile = vendorFetched[vendorPubkey] || vendorStored || {};
  const vendorName = noHexName(vendorProfile, vendorPubkey);

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
      // Trust stays with the fact the send produced, said where the eye
      // already is: the sealed note is exactly what the buyer just paid to
      // have made — one open, that vendor, and never again.
      pushToast({ type: 'success', message: 'Sealed. Only the vendor can open it.' });
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
      {/* After the send lands the sheet becomes the confirmation moment:
          who it went to, what is happening now, and the jump into that
          chat. The trust line about the sealed note rides the toast, not a
          stretched button label. */}
      {confirmed ? (
        <div className="flex flex-col items-center py-4 text-center">
          <Avatar src={vendorProfile.picture} name={vendorName} pubkey={vendorPubkey} size="lg" />
          <p className="mt-3 text-[15px] font-semibold text-ink">{vendorName}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-inkMuted">Order sent. Waiting for them to accept.</p>
          <button
            type="button"
            onClick={() => { pushToast({ type: 'info', message: 'Sealed. Only the vendor can open it.' }); onJumpToChat?.(); }}
            className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-bold text-accentInk"
          >
            <MessageCircle size={16} /> Go to the chat
          </button>
        </div>
      ) : (
        <>
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
          <p className="font-mono text-[20px] font-bold text-ink">{amount}</p>
        </div>
        {/* The one explanation wall the sheet keeps. Everything else about
            paying — the accepted order, the issued address, the QR, the
            chain check — lives in Profile → How to use, Buying; a second
            panel here repeated it at the exact moment the buyer only wants
            to fill fields and send. (security S2: the address travels
            sealed in a burn-once note, the order carries its URL; no
            payment address ever sits on a menu or in this sheet.) */}
        <div className="space-y-3 pt-1">
          <p className="text-[13px] leading-relaxed text-inkMuted">
            Your address goes to the vendor once, sealed — never into the chat,
            <br />
            never off your phone any other way. The note will not open again on their
            phone. Cipher checks its shape, not the address — that part is between you
            and the mail.
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
        {orderError && <p role="alert" className="text-sm text-danger">{orderError}</p>}
      </div>
      <div className="px-0 pt-5">
        <button
          type="button"
          onClick={confirmOrder}
          disabled={sending}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-accent font-bold text-accentInk active:bg-accent disabled:opacity-60"
        >
          {sending ? <><Loader2 size={17} className="animate-spin" /> Sealing…</> : 'Seal and send'}
        </button>
      </div>
        </>
      )}
    </Sheet>
  );
}
