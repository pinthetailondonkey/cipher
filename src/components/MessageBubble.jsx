import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BadgeCheck, Check, CheckCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { paymentRowsFor } from '../lib/paymentUri';
import { copyText } from '../lib/copyText';
import { haptic } from '../lib/haptics';
import { securingPhase } from '../lib/crypto/groupKeyRequest';
import { useChatStore } from '../store/chatStore';
import LinkPreview, { firstUrl } from './chat/LinkPreview';
import Sheet from './ui/Sheet';
import Picture from './ui/Picture';
import { MediaImage } from './ui/PrivateMedia';
import { attachmentsFor } from '../lib/mediaCrypto';
import { allowsLinkPreviews } from '../lib/privacy';
import { orderActionsFor, orderState } from '../lib/orderActions';
import { reviewOfferForOrder } from '../lib/vendorReviews';
import ReviewPrompt from './chat/ReviewPrompt';
import { nameColorOf } from '../lib/nameColor';
import { escrowActionsFor, escrowForCard, escrowRowsFor } from '../lib/escrowActions';
import EscrowFactBox from './chat/EscrowFactBox';

// The escrow wire-up (slot keys, quotes, accept-escrow actions) lands inside
// useCommerce on the escrow branch. Until that commit reaches the app the
// door stays out — no unwired buttons. Flip when the wiring lands (grep:
// accept_with_escrow / escrowRequestSlot in src/features/chat/useCommerce.js).
const ESCROW_WIRING_LANDED = false;
import EscrowTimeline from './chat/EscrowTimeline';
import EscrowDormantRow from './chat/EscrowDormantRow';
import { noHexName } from '../lib/npub';
import { scopedGet } from '../lib/storage';
import ReceiptInspect from './chat/ReceiptInspect';
import { forwardableContent } from './chat/useThreadActions';
import { orderPriceLabel } from '../lib/listing';
import VoiceNote from './chat/VoiceNote';
import MessageContextMenu from './chat/MessageContextMenu';
import { jumpToMessage } from './chat/threadMotion';
import './chat/thread.css';

const EMPTY_REACTIONS = [];

function messageText(data) {
  if (!data) return '';
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return messageText(parsed);
    } catch { /* plain text */ }
    return trimmed;
  }
  if (data.type === 'order_request' || data.type === 'cipher_order' || data.type === 'order_update') return '';
  if (data.type === 'product') return data.title || data.name || 'Product';
  return data.message || data.caption || data.text || data.body || '';
}

// Split message text into plain strings and { url } tokens so links render
// as real anchors. Uses the same URL shape firstUrl already accepts; trailing
// punctuation stays with the text around the link.
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function urlTokens(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const raw = match[0];
    const trail = raw.match(/[),.!?]+$/)?.[0] || '';
    const url = trail ? raw.slice(0, raw.length - trail.length) : raw;
    out.push({ url });
    if (trail) out.push(trail);
    last = match.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function orderLabel(content) {
  if (content.paymentState === 'confirmed') return { text: 'Confirmed', className: 'bg-accent text-accentInk' };
  if (content.status === 'shipped') return { text: 'Shipped', className: 'bg-accent text-accentInk' };
  if (content.status === 'completed') return { text: 'Delivered', className: 'bg-success text-accentInk' };
  if (content.status === 'cancelled') return { text: 'Cancelled', className: 'bg-ink/15 text-inkMuted' };
  if (content.status === 'refunded') return { text: 'Refunded', className: 'bg-ink/15 text-inkMuted' };
  // Disputed wears the danger outline: the danger token is a plain var(),
  // so a /15 fill would never generate, and the outline reads anyway.
  if (content.status === 'disputed') return { text: 'Disputed', className: 'border border-danger bg-transparent text-danger' };
  if (content.paymentState === 'seen' && content.paymentSeenBy !== 'vendor') return { text: 'Seen on-chain', className: 'bg-accent text-accentInk' };
  if (content.status === 'paid' || content.paymentSeenBy === 'vendor') return { text: 'Marked paid', className: 'bg-accent text-accentInk' };
  // Money badges read as outline: accent-text ring and label, no fill.
  const outline = 'border border-accentText bg-transparent uppercase tracking-[0.08em] text-accentText';
  if (content.status === 'accepted' || content.paymentState === 'address_issued') return { text: 'Address sent', className: outline };
  return { text: 'Awaiting payment', className: 'bg-accentSoft text-accentText' };
}

function OrderReceipt({ content }) {
  const product = content.product || {};
  const title = product.title || product.name || content.productName || 'Order';
  const price = orderPriceLabel(content);
  const address = content.shippingAddress || content.address || content.shipTo || '';
  const pill = orderLabel(content);
  return (
    // Telegram's attached card: the card takes the full bubble width, up
    // to 280px, and the product shot crops flat to 28:9.
    <div className="w-full max-w-[280px] overflow-hidden rounded-2xl border border-line bg-panel text-left">
      <Picture src={product.image} alt="" className="aspect-[28/9] w-full object-cover" />
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[15px] font-semibold text-ink">{title}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill.className}`}>{pill.text}</span>
        </div>
        {price && <p className="mt-1 text-[15px] font-bold text-accentText">{price}</p>}
        {escrow && (
          // The escrow quote on the card: prices read back only after they
          // re-derive on this device (escrowForCard), so the words under
          // the pill are this device's own arithmetic, never the peer's.
          <EscrowFactBox escrow={escrow} />
        )}
        <EscrowTimeline
          quote={escrow}
          status={content.status}
          paymentState={content.paymentState}
          paymentSeenBy={content.paymentSeenBy}
        />
        {content.paymentSeenBy === 'vendor' && content.paymentState !== 'confirmed' && (
          <p className="mt-1 text-[13px] text-ink/50">Not checked on-chain.</p>
        )}
        {address && <p className="mt-1 text-[13px] text-ink/40">Ship to {address}</p>}
      </div>
    </div>
  );
}

// The receipt door on an order card. The id the receipt is filed under is
// the order's own event id — an order_update carries it inline in the
// payload, the original order IS that id. The door prefers the receipt the
// sender actually attached, then the copy this device stored; ReceiptInspect
// decides whether either deserves the word.
function ReceiptDoor({ message, content }) {
  const [open, setOpen] = useState(false);
  const orderId = content.type === 'order_update' ? (content.orderId || message.id) : message.id;
  const receipt = content.receipt || scopedGet(`receipt_${orderId}`, null);
  if (!receipt) return null;
  return (
    <>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        className="mb-1 block min-h-11 text-left text-[15px] font-semibold text-accentText"
      >
        View receipt
      </button>
      <ReceiptInspect receipt={receipt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function OrderActionButton({ action, label, target, message, content, activeDm, onAction, toneByAction }) {
  // Vendor actions send to the buyer, msg.pubkey; buyer actions to the chat peer.
  const subject = target === 'peer' ? { ...message, pubkey: activeDm, data: content } : { ...message, data: content };
  const tone = (
    { accept_order: 'text-blue-300', ...(toneByAction || {}) }[action]
    || (['report_issue', 'decline_order', 'cancel_order'].includes(action) ? 'text-rose-300' : 'text-ink')
  );
  return (
    <button key={action} type="button" onClick={(event) => { event.stopPropagation(); onAction?.(action, subject); }} className={`mb-1 block min-h-11 text-left text-[15px] font-semibold ${tone}`}>{label}</button>
  );
}

// The delivery address, read out of the buyer's burned note and saved on
// this device. Plain rows, selectable to copy — no third-party lookup,
// no map, no autocomplete ever. The words stay blame-free.
function DeliveryAddressRow({ address }) {
  if (!address) return null;
  const lines = (Array.isArray(address.lines) ? address.lines : []).filter(Boolean);
  const region = [address.region, address.postal].filter(Boolean).join(' ');
  return (
    <div className="mb-1 rounded-xl bg-panelStrong p-3 text-[13px] text-inkMuted">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-inkSubtle">Delivery address</p>
      {address.name ? <p className="select-all font-semibold text-ink">{address.name}</p> : null}
      {lines.map((line, index) => <p key={index} className="select-all">{line}</p>)}
      {[address.city, region].filter(Boolean).length > 0 && (
        <p className="select-all">{[address.city, region].filter(Boolean).join(', ')}</p>
      )}
      {address.country ? <p className="select-all">{address.country}</p> : null}
      <p className="mt-1 text-[12px] text-inkSubtle">Sealed by the buyer. The note burned after one open.</p>
    </div>
  );
}

// The payment block: the existing paidRows merge rendered as one card per
// coin — pay line, QR, selectable address, then the address overflow row.
function PaymentBlock({ rows }) {
  return (
    <div className="mb-1 space-y-2">
      {rows.map(({ currency, address, amount, uri }) => (
        <div key={currency} className="flex flex-col items-center gap-1 rounded-xl bg-ink p-2">
          {amount && <p className="select-all text-center font-mono text-[15px] font-bold text-scrim">Pay {amount} {currency}</p>}
          <span className="flex justify-center rounded-md bg-scrim/80 p-1">
            <QRCodeSVG value={uri} size={120} level="M" />
          </span>
          <span className="select-all break-all text-center font-mono text-[10px] text-scrim/80">{address}</span>
          <span className="flex w-full items-center justify-between gap-1 border-t border-scrim/15 pt-1">
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); haptic('light'); copyText(address); }}
              className="min-h-[44px] flex-1 text-[12px] font-semibold text-scrim/80 active:opacity-80"
            >
              Copy address
            </button>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); haptic('light'); copyText(uri); }}
              className="min-h-[44px] flex-1 text-[12px] font-semibold text-scrim/80 active:opacity-80"
            >
              Share link
            </button>
            <a
              href={uri}
              target="_blank"
              rel="noreferrer noopener"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              className="flex min-h-[44px] flex-1 items-center justify-center text-[12px] font-semibold text-scrim/80 active:opacity-80"
            >
              Wallet
            </a>
          </span>
        </div>
      ))}
    </div>
  );
}

// Run boundaries arrive from the view that maps the messages: a run is a
// stretch of consecutive bubbles from the same author, so only the run's last
// bubble wears the squared corner and (in groups) the avatar.
export default function MessageBubble({ message, data, onAction, senderName, identity = null, isPinnedListing = false, showAvatar = false, avatarUrl = '', avatarInitial = '?', canPin = false, runStart = true, runEnd = true, selectMode = false, selected = false, onToggleSelect }) {
  const content = data || message?.data || {};
  const text = messageText(content) || messageText(message?.rawContent) || messageText(message?.text) || '';
  const isSender = !!message?.isSender;
  const timestamp = Number(message?.timestamp);
  const validTimestamp = Number.isFinite(timestamp) ? timestamp : null;
  const [open, setOpen] = useState(false);
  const [showReactors, setShowReactors] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const mountedAt = useRef(Date.now() / 1000);
  const deleted = useChatStore((state) => state.deletedMsgs);
  const reactions = useChatStore((state) => (message?.id ? state.reactions[message.id] : undefined)) || EMPTY_REACTIONS;
  const profiles = useChatStore((state) => state.profiles);
  const inGroup = useChatStore((state) => !!state.activeGroup);
  const activeDm = useChatStore((state) => state.activeDm);
  const chatMessages = useChatStore((state) => (state.view === 'dm' ? state.dms[state.activeDm] : undefined));
  // The reply quote reads its parent from THIS thread's list, dm or group.
  const replyThread = useChatStore((state) => (state.view === 'group' ? state.groupMessages[state.activeGroup?.id] : state.dms[state.activeDm]) || []);
  // The review offer composes only where it can: this device holds the
  // bound receipt, the viewer is its buyer, and the deal reads completed.
  // Anything else and no door renders.
  const reviewOffer = (content.type === 'cipher_order' || content.type === 'order_request') && identity?.pk && activeDm
    ? reviewOfferForOrder({
        messages: chatMessages || [],
        order: message,
        buyerPubkey: identity.pk,
        vendorPubkey: activeDm,
      })
    : null;
  const pressTimer = useRef(null);
  const pressPoint = useRef(null);
  const paymentRows = paymentRowsFor(content);
  const attachments = attachmentsFor(content);
  // Escrow rows arrive only on an accepted card whose quote re-derives
  // here, and only when the refund key is the buyer's own slot (the
  // buyer-side claim test in escrowRowsFor; the vendor's own card
  // carries its own quote). Money state gating comes with the membrane
  // reroute — the FSM owns it, not a peer's word.
  const escrowRows = escrowRowsFor(message, chatMessages, content);
  const paidRows = [...paymentRows, ...escrowRows];
  const qrSignature = `${message?.id || ''}:${paidRows.map((row) => row.currency).join(',')}`;
  const lastQrSignature = useRef('');

  useEffect(() => {
    if (paidRows.length && qrSignature !== lastQrSignature.current) {
      lastQrSignature.current = qrSignature;
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([20, 40, 20]);
    }
  }, [paidRows.length, qrSignature]);

  useEffect(() => {
    if (message?.deliveryStatus !== 'securing') return undefined;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [message?.deliveryStatus, message?.id]);

  const senderTint = useMemo(() => nameColorOf(message?.pubkey || senderName || ''), [message?.pubkey, senderName]);
  const securingSince = message?.securingSince || message?.local_timestamp || (validTimestamp ? validTimestamp * 1000 : 0);
  const securingStuck = message?.deliveryStatus === 'securing' && securingPhase(securingSince, clock) === 'stuck';
  const deliveryLabel = {
    sending: 'Sending',
    queued: 'Queued',
    failed: 'Failed',
    securing: securingStuck ? '' : 'Securing…',
  }[message?.deliveryStatus];
  const read = message?.read || message?.deliveryStatus === 'read';
  // Meta pill sits inside the bubble, bottom-right 10px: time + edited +
  // delivery ticks. On the accent bubble it wears a translucent scrim; read
  // swaps the tick to the lucide CheckCheck pair.
  const ticks = isSender && !deliveryLabel
    ? (read ? <CheckCheck size={13} aria-label="Read" /> : <Check size={13} aria-label="Sent" />)
    : null;
  const timeLabel = validTimestamp === null ? '' : new Date(validTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const time = (
    <span className={`float-right ml-2 mt-[5px] inline-flex items-center gap-1 rounded-full px-1.5 py-[3px] text-[10px] leading-none ${isSender ? 'bg-scrim/25 text-accentInk/80' : 'bg-panelAlt text-inkSubtle'}`}>
      {message?.edited && <span>edited</span>}
      {isSender && deliveryLabel && <span className={message?.deliveryStatus === 'failed' ? 'text-danger' : ''}>{deliveryLabel}</span>}
      {ticks}
      <time dateTime={validTimestamp === null ? undefined : new Date(validTimestamp * 1000).toISOString()}>{timeLabel}</time>
    </span>
  );

  const previewUrl = firstUrl(text);
  const grouped = reactions.reduce((map, reaction) => {
    const bucket = map.get(reaction.emoji) || [];
    bucket.push(reaction);
    map.set(reaction.emoji, bucket);
    return map;
  }, new Map());
  const justArrived = message?.deliveryStatus === 'sending' || (Number(message?.timestamp) >= mountedAt.current - 2);
  if (message?.id && deleted instanceof Set && deleted.has(message.id)) return null;

  // The reply quote: 2px accent bar, 12px quote line, 13px inkMuted fallback
  // strip. Tap jumps to the msg-<id> anchor with the 2s glow ring.
  const replyTo = message?.replyTo || message?.data?.replyTo || null;
  const replyParent = replyTo ? replyThread.find((item) => item?.id === replyTo || item?.clientId === replyTo) : null;
  const replyQuote = replyParent ? (messageText(replyParent?.data) || messageText(replyParent?.rawContent) || '') : '';
  const replyAuthor = replyParent
    ? (replyParent.isSender ? 'You' : noHexName(profiles, replyParent.pubkey))
    : 'Reply';

  const act = (action, extra = {}) => {
    onAction?.(action, { ...message, data: content, text, ...extra });
    setOpen(false);
  };
  const clearPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const startPress = (event) => {
    if (selectMode) return;
    if (event.button && event.button !== 0) return;
    pressPoint.current = { x: event.clientX, y: event.clientY };
    clearPress();
    pressTimer.current = window.setTimeout(() => {
      haptic('medium');
      setOpen(true);
    }, 420);
  };
  const movePress = (event) => {
    if (!pressPoint.current) return;
    const dx = Math.abs(event.clientX - pressPoint.current.x);
    const dy = Math.abs(event.clientY - pressPoint.current.y);
    if (dx > 10 || dy > 10) clearPress();
  };

  const forwardable = forwardableContent(content);
  const menuActions = [
    { action: 'reply', label: 'Reply' },
    { action: 'copy', label: 'Copy' },
    ...(forwardable ? [{ action: 'forward', label: 'Forward' }] : []),
    { action: 'bookmark', label: 'Save' },
    // S9: the shared pinned slot is an owner or admin choice, so the pin
    // option only shows for one. The group hook re-checks standing anyway.
    ...(inGroup && canPin ? [{ action: 'pin', label: 'Pin' }] : []),
    ...(isSender && text && content.type !== 'product' ? [{ action: 'edit', label: 'Edit' }] : []),
    ...(content.type === 'product' && !isSender ? [{ action: 'buy_product', label: 'Buy' }, { action: 'view_vendor', label: 'Their menu' }] : []),
    ...(content.type === 'product' && isSender ? [{ action: 'broadcast_product', label: 'Share' }, { action: 'edit_product', label: 'Edit listing' }] : []),
    { action: 'select', label: 'Select' },
    { action: 'delete', label: 'Delete', danger: true },
  ];

  return (
    <>
    <motion.article
      id={message?.id ? `msg-${message.id}` : undefined}
      initial={justArrived ? { y: 18, opacity: 0 } : false}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      className={`flex w-full items-end gap-2 ${runEnd ? 'mb-2' : 'mb-0.5'} ${isSender ? 'justify-end pr-3' : 'justify-start pl-3'}`}
    >
      {selectMode && (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onToggleSelect?.(message); }}
          aria-label={selected ? 'Unselect message' : 'Select message'}
          aria-pressed={selected}
          className="flex h-11 w-8 shrink-0 items-center justify-center self-center"
        >
          <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-accent bg-accent text-accentInk' : 'border-inkMuted/50'}`}>
            {selected && <Check size={14} />}
          </span>
        </button>
      )}
      {!isSender && showAvatar && !selectMode && (
        runEnd
          ? <Picture src={avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" fallback={<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-panelAlt text-[11px] font-semibold" style={{ color: senderTint }}>{avatarInitial}</span>} />
          : <span className="h-7 w-7 shrink-0" aria-hidden="true" />
      )}
      <div
        role={selectMode ? 'checkbox' : 'button'}
        aria-checked={selectMode ? selected : undefined}
        tabIndex={0}
        onPointerDown={startPress}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onPointerMove={movePress}
        onContextMenu={(event) => { event.preventDefault(); haptic('medium'); setOpen(true); }}
        onClick={(event) => {
          if (!selectMode) return;
          event.stopPropagation();
          onToggleSelect?.(message);
        }}
        onKeyDown={(event) => { if (selectMode && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onToggleSelect?.(message); } }}
        // One squared corner per run of same-sender bubbles: the tail corner
        // rounds to 6px only on the run's last bubble, everything else stays
        // at the 18px pill. Anchor image, skeleton B.
        className={`max-w-[76%] min-w-[4.5rem] border px-3 py-2 text-ink ${isSender ? 'rounded-[18px] border-accent bg-accent text-accentInk' : 'rounded-[18px] border-line bg-panel'} ${runEnd ? (isSender ? 'rounded-br-[6px]' : 'rounded-bl-[6px]') : ''}`}
      >
        {!isSender && senderName && runStart && (
          <p className="mb-0.5 text-[11px] font-semibold leading-none" style={{ color: senderTint }}>{senderName}</p>
        )}
        {replyParent && (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); jumpToMessage(replyParent.id); }}
            className="mb-1 flex w-full min-h-[44px] items-stretch gap-2 rounded-lg bg-ink/5 px-1.5 py-1 text-left"
          >
            <span aria-hidden="true" className="w-[2px] shrink-0 self-stretch rounded-full bg-accent" />
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-semibold text-accentText">{replyAuthor}</span>
              <span className="block truncate text-[13px] text-inkMuted">{replyQuote || 'Message unavailable'}</span>
            </span>
          </button>
        )}
        {(content.type === 'cipher_order' || content.type === 'order_request' || content.type === 'order_update') && (
          // F7: the badge reads derived payment facts, not what the update
          // itself claims — a received "confirmed" with no receipt behind it
          // reads back as its real state.
          <OrderReceipt content={{ ...content, ...orderState(chatMessages, message?.id, { data: content }, '', activeDm) }} />
        )}
        {(content.type === 'cipher_order' || content.type === 'order_update') && (
          <ReceiptDoor message={message} content={content} />
        )}
        {content.delivery?.address && <DeliveryAddressRow address={content.delivery.address} />}
        {!message.isSender && content.type === 'cipher_order' && content.delivery?.note && !content.delivery?.address && (
          // The delivery door: only the vendor sees it, only while the
          // address is not yet saved on this device. Opening checks the
          // address locally, saves it into the order record, then burns
          // the note; the button disappears once the address is down.
          <OrderActionButton
            key="open_delivery_note"
            action="open_delivery_note"
            label="Open the delivery note"
            target="request"
            message={message}
            content={content}
            activeDm={activeDm}
            onAction={onAction}
            toneByAction={{ open_delivery_note: 'text-accentText' }}
          />
        )}
        {orderActionsFor({ ...message, data: content }, chatMessages, '', activeDm).map(({ action, label, target }) => (
          <OrderActionButton key={`o-${action}`} action={action} label={label} target={target} message={message} content={content} activeDm={activeDm} onAction={onAction} />
        ))}
        {ESCROW_WIRING_LANDED && escrowActionsFor({ ...message, data: content }, chatMessages).map(({ action, label, target }) => (
          // The escrow door: same subject as the direct accept, its own tone
          // (accent-text, the ask marked by colour).
          <OrderActionButton key={`e-${action}`} action={action} label={label} target={target} message={message} content={content} activeDm={activeDm} onAction={onAction} toneByAction={{ accept_with_escrow: 'text-accentText' }} />
        ))}
        {reviewOffer && (
          // The review door: the offer is already gated — a bound receipt on
          // this device, the buyer's key on it, the deal completed. Anything
          // else and it never renders.
          <ReviewPrompt offer={reviewOffer} vendorProfile={profiles[activeDm] || {}} identity={identity} />
        )}
        <EscrowDormantRow content={content} isBuyer={!!message.isSender} />
        {attachments.layout === 'single' && (
          <MediaImage item={attachments.items[0]} className="max-h-64 max-w-full rounded-xl object-contain" />
        )}
        {attachments.layout === 'grid' && (
          <div className="grid grid-cols-2 gap-1">
            {attachments.items.map((item) => (
              <MediaImage key={item.entry.url} item={item} className="h-28 w-full rounded-lg object-cover" />
            ))}
          </div>
        )}
        {attachments.layout === 'audio' && <VoiceNote item={attachments.items[0]} name={content.name || ''} sent={isSender} className="mb-1" />}
        {content.type === 'product' && <Picture src={content.image} alt="" loading="lazy" className="mb-1 max-h-40 rounded-xl object-cover" />}
        {content.type === 'product' && isPinnedListing && (
          <p className="mb-1 inline-flex items-center gap-1 rounded-full border border-accentText px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-accentText"><BadgeCheck size={12} /> Pinned</p>
        )}
        {paidRows.length > 0 && (
          // The payment block: one black inset panel per coin. The address
          // is the trust edge — selectable, copyable, openable in the
          // wallet, never rendered by an explorer link.
          <div className="mb-1 space-y-2">
            {paidRows.map(({ currency, address, amount, uri }) => (
              <div key={`${currency}-${address}`} className="flex flex-col items-center rounded-xl bg-panelStrong p-2">
                {amount && <p className="mb-1 select-all text-center font-mono text-[15px] font-bold text-inkMuted">Pay {amount} {currency}</p>}
                <QRCodeSVG value={uri} size={120} level="M" />
                <span className="mt-1 select-all break-all text-center font-mono text-[10px] text-inkMuted">{address}</span>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); copyText(address); }} className="min-h-[44px] rounded-full border border-line px-3 py-1.5 text-[13px] font-semibold text-accentText">Copy address</button>
                  <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); haptic('light'); sharePayment(currency, address, amount, uri); }} className="min-h-[44px] rounded-full border border-line px-3 py-1.5 text-[13px] font-semibold text-accentText">Share link</button>
                  {uri && (
                    <a href={uri} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[13px] font-semibold text-accentText">
                      Open in wallet
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {text ? (
          <p className="whitespace-pre-wrap break-words text-[14.5px] leading-[1.28]">
            {urlTokens(text).map((token, i) => (
              typeof token === 'string'
                ? <React.Fragment key={i}>{token}</React.Fragment>
                : (
                  <a
                    key={i}
                    href={token.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    className={`break-all underline ${isSender ? 'text-accentInk' : 'text-accentText'}`}
                  >
                    {token.url}
                  </a>
                )
            ))}
            {time}
          </p>
        ) : (
          <p className="clear-both text-[12px] leading-none">{time}</p>
        )}
        {previewUrl && allowsLinkPreviews() && <LinkPreview url={previewUrl} />}
        {securingStuck && (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); haptic('light'); onAction?.('retry_secure', message); }}
            className={`mt-2 block min-h-[44px] w-full text-left text-[15px] font-semibold underline active:scale-95 ${isSender ? 'text-accentInk' : 'text-accentText'}`}
          >
            Still securing — retry
          </button>
        )}
        {grouped.size > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {[...grouped.entries()].map(([emoji, people]) => (
              <motion.button
                key={emoji}
                type="button"
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                onClick={(event) => { event.stopPropagation(); setShowReactors(emoji); }}
                className="rounded-full border border-ink/10 bg-scrim/40 px-1.5 py-0.5 text-[12px] text-ink"
              >
                {emoji} {people.length}
              </motion.button>
            ))}
          </div>
        )}
        {!text && !content.url && !content.urls && !content.media && !paidRows.length && !['image', 'audio', 'product', 'cipher_order', 'order_request', 'order_update', 'text'].includes(content.type) && (
          <p className="text-[13px] text-inkSubtle">Couldn't open</p>
        )}
      </div>
    </motion.article>
    <MessageContextMenu
      open={open}
      onClose={() => setOpen(false)}
      onAction={(action, emoji) => act(action, emoji ? { emoji } : {})}
      items={menuActions}
    />
    {showReactors && (
      <Sheet open onClose={() => setShowReactors(false)} label="Reactions">
        <p className="mb-3 text-[15px] font-semibold text-ink">{showReactors}</p>
        {(grouped.get(showReactors) || []).map((person) => (
          <p key={person.pubkey} className="border-b border-ink/5 py-2 text-[13px] text-ink/80">
            {noHexName(profiles[person.pubkey], person.pubkey)}
          </p>
        ))}
      </Sheet>
    )}
    </>
  );
}

