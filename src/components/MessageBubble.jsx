import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BadgeCheck, Bookmark, Copy, Pencil, Pin, Radio, Reply, ShoppingBag, Store, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { paymentRowsFor } from '../lib/paymentUri';
import { haptic } from '../lib/haptics';
import { securingPhase } from '../lib/crypto/groupKeyRequest';
import { useChatStore } from '../store/chatStore';
import LinkPreview, { firstUrl } from './chat/LinkPreview';
import Picture from './ui/Picture';
import { MediaAudio, MediaImage } from './ui/PrivateMedia';
import { attachmentsFor } from '../lib/mediaCrypto';
import { allowsLinkPreviews } from '../lib/privacy';
import { orderActionsFor, orderState, orderStatusOf } from '../lib/orderActions';
import { escrowActionsFor, escrowDelayDays, escrowForCard, escrowRowsFor } from '../lib/escrowActions';
import { unitsToCoins } from '../lib/paymentState';
import { noHexName } from '../lib/npub';
import { orderPriceLabel } from '../lib/listing';

const EMPTY_REACTIONS = [];
const REACTION_CHOICES = ['❤️', '👍', '🔥', '😂', '😮', '😢', '🙏'];

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
  if (content.status === 'completed') return { text: 'Delivered', className: 'bg-emerald-500 text-ink' };
  if (content.status === 'cancelled') return { text: 'Cancelled', className: 'bg-ink/15 text-ink' };
  if (content.status === 'refunded') return { text: 'Refunded', className: 'bg-ink/15 text-ink' };
  if (content.status === 'disputed') return { text: 'Disputed', className: 'bg-rose-500/20 text-rose-200' };
  if (content.paymentState === 'seen' && content.paymentSeenBy !== 'vendor') return { text: 'Seen on-chain', className: 'bg-accent text-accentInk' };
  if (content.status === 'paid' || content.paymentSeenBy === 'vendor') return { text: 'Marked paid', className: 'bg-accent text-accentInk' };
  if (content.status === 'accepted' || content.paymentState === 'address_issued') return { text: 'Address sent', className: 'bg-amber-400 text-scrim' };
  return { text: 'Awaiting payment', className: 'bg-amber-400 text-scrim' };
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

function OrderReceipt({ content }) {
  const product = content.product || {};
  const title = product.title || product.name || content.productName || 'Order';
  const price = orderPriceLabel(content);
  const address = content.shippingAddress || content.address || content.shipTo || '';
  const pill = orderLabel(content);
  const escrow = escrowForCard(content);
  return (
    <div className="mb-1 overflow-hidden rounded-2xl border border-line bg-panel shadow-lg text-left">
      <Picture src={product.image} alt="" className="h-28 w-full object-cover" />
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[15px] font-semibold text-ink">{title}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill.className}`}>{pill.text}</span>
        </div>
        {price && <p className="mt-1 text-[13px] font-bold text-accent">{price}</p>}
        {escrow && (
          // The escrow quote on the card: prices read back only after they
          // re-derive on this device (escrowForCard), so the words under
          // the pill are this device's own arithmetic, never the peer's.
          <div className="mt-1 rounded-xl border border-line bg-panelStrong p-2 text-left">
            <p className="text-[11px] font-bold uppercase tracking-wide text-accent">In escrow</p>
            <p className="mt-0.5 text-[13px] text-ink/75">
              Price {unitsToCoins(escrow.priceSats, 'btc')} BTC · deposit {unitsToCoins(escrow.depositSats, 'btc')} BTC · fee {unitsToCoins(escrow.feeOutSats, 'btc')} BTC (2.5% + 2.5%)
            </p>
            <p className="mt-0.5 text-[13px] text-ink/50">{escrowDelayDays(escrow.delayBlocks)}-day timer. Money comes back if the deal can't be proven — it can't inspect the goods.</p>
          </div>
        )}
        {content.escrowSalt && !escrow && content.status === 'accepted'
          && ['created', 'address_issued'].includes(content.paymentState) && (
          // Slotted but unfunded, accepted without escrow: the buyer is
          // about to pay with no box. Founder-approved line, verbatim.
          <p className="mt-1 text-[13px] text-amber-300">No escrow on this order. If it goes wrong, the money is gone.</p>
        )}
        {content.paymentSeenBy === 'vendor' && content.paymentState !== 'confirmed' && (
          <p className="mt-1 text-[13px] text-amber-300">Not checked on-chain.</p>
        )}
        {address && <p className="mt-1 text-[13px] text-ink/40">Ship to {address}</p>}
      </div>
    </div>
  );
}

export default function MessageBubble({ message, data, onAction, senderName, isPinnedListing = false, showAvatar = false, avatarUrl = '', avatarInitial = '?', canPin = false }) {
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
  const pressTimer = useRef(null);
  const pressPoint = useRef(null);
  // The founder's pre-acceptance cancel is absolute: when the order's
  // timeline tallies to cancelled, no money row renders — not even off a
  // late acceptance that raced the cancel (the resurrection lie). The
  // row gates read the same sticky status the action tables read.
  const cancelledOrder = message?.data?.type === 'order_update'
    && orderStatusOf(chatMessages, message.data.orderId, chatMessages?.find((m) => m?.id === message.data.orderId)) === 'cancelled';
  const paymentRows = cancelledOrder ? [] : paymentRowsFor(content);
  // Escrow rows arrive only on an accepted card whose quote re-derives
  // here, and only when the refund key is the buyer's own slot (the
  // buyer-side claim test in escrowRowsFor; the vendor's own card
  // carries its own quote). Money state gating comes with the membrane
  // reroute — the FSM owns it, not a peer's word.
  const escrowRows = cancelledOrder ? [] : escrowRowsFor(message, chatMessages, content);
  const paidRows = [...paymentRows, ...escrowRows];
  const attachments = attachmentsFor(content);
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

  const avatarColor = ['text-accent', 'text-sky-400', 'text-indigo-300', 'text-cyan-300'][(message?.pubkey?.charCodeAt(0) || 0) % 4];
  const securingSince = message?.securingSince || message?.local_timestamp || (validTimestamp ? validTimestamp * 1000 : 0);
  const securingStuck = message?.deliveryStatus === 'securing' && securingPhase(securingSince, clock) === 'stuck';
  const deliveryLabel = {
    sending: 'Sending',
    queued: 'Queued',
    failed: 'Failed',
    securing: securingStuck ? '' : 'Securing…',
  }[message?.deliveryStatus];
  const read = message?.read || message?.deliveryStatus === 'read';
  const checks = isSender && !deliveryLabel
    ? <span className={read ? 'text-accent' : 'text-ink/45'}>{read ? '✓✓' : '✓'}</span>
    : null;
  const timeLabel = validTimestamp === null ? '' : new Date(validTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const time = (
    <span className="float-right ml-2 mt-[5px] inline-flex items-center gap-1 text-[10px] leading-none text-ink/45">
      {message?.edited && <span>edited</span>}
      {isSender && deliveryLabel && <span className={message?.deliveryStatus === 'failed' ? 'text-rose-200' : ''}>{deliveryLabel}</span>}
      {checks}
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

  const act = (action, extra = {}) => {
    onAction?.(action, { ...message, data: content, text, ...extra });
    setOpen(false);
  };
  const clearPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const startPress = (event) => {
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
  const menuActions = [
    ['reply', Reply, 'Reply'],
    ['copy', Copy, 'Copy'],
    ['bookmark', Bookmark, 'Save'],
    // S9: the shared pinned slot is an owner or admin choice, so the pin
    // option only shows for one. The group hook re-checks standing anyway.
    ...(inGroup && canPin ? [['pin', Pin, 'Pin']] : []),
    ...(content.type === 'product' && !isSender ? [['buy_product', ShoppingBag, 'Buy'], ['view_vendor', Store, 'Seller shop']] : []),
    ...(content.type === 'product' && isSender ? [['broadcast_product', Radio, 'Share'], ['edit_product', Pencil, 'Edit listing']] : []),
    ...(isSender && text && content.type !== 'product' ? [['edit', Pencil, 'Edit']] : []),
    ['delete', Trash2, 'Delete'],
  ];

  return (
    <>
    <motion.article
      id={message?.id ? `msg-${message.id}` : undefined}
      initial={justArrived ? { y: 18, opacity: 0 } : false}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      className={`flex w-full items-end gap-2 px-3 py-1 ${isSender ? 'justify-end' : 'justify-start'}`}
    >
      {!isSender && showAvatar && (
        <Picture src={avatarUrl} alt="" className="mb-0.5 h-7 w-7 shrink-0 rounded-full object-cover" fallback={<span className={`mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#161616] text-[11px] font-semibold ${avatarColor}`}>{avatarInitial}</span>} />
      )}
      <div
        role="button"
        tabIndex={0}
        onPointerDown={startPress}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onPointerMove={movePress}
        onContextMenu={(event) => { event.preventDefault(); haptic('medium'); setOpen(true); }}
        className={`max-w-[78%] min-w-[4.5rem] rounded-2xl border px-3 py-2 ${isSender ? 'border-accent bg-accent text-accentInk' : 'border-line bg-panel shadow-lg text-ink'}`}
      >
        {!isSender && senderName && <p className="mb-0.5 text-[11px] font-semibold leading-none text-accent">{senderName}</p>}
        {(content.type === 'cipher_order' || content.type === 'order_request' || content.type === 'order_update') && (
          // F7: the badge reads derived payment facts, not what the update
          // itself claims — a received "confirmed" with no receipt behind it
          // reads back as its real state.
          <OrderReceipt content={{ ...content, ...orderState(chatMessages, message?.id, { data: content }) }} />
        )}
        {orderActionsFor({ ...message, data: content }, chatMessages).map(({ action, label, target }) => (
          <OrderActionButton key={action} action={action} label={label} target={target} message={message} content={content} activeDm={activeDm} onAction={onAction} />
        ))}
        {escrowActionsFor({ ...message, data: content }, chatMessages).map(({ action, label, target }) => (
          <OrderActionButton key={action} action={action} label={label} target={target} message={message} content={content} activeDm={activeDm} onAction={onAction} toneByAction={{ accept_with_escrow: 'text-blue-300' }} />
        ))}
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
        {attachments.layout === 'audio' && <MediaAudio item={attachments.items[0]} className="h-8 max-w-full" />}
        {content.type === 'product' && <Picture src={content.image} alt="" loading="lazy" className="mb-1 max-h-40 rounded-xl object-cover" />}
        {content.type === 'product' && isPinnedListing && (
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><BadgeCheck size={12} /> Pinned</p>
        )}
        {paidRows.length > 0 && (
          <div className="mb-1 space-y-2">
            {paidRows.map(({ currency, address, amount, uri }) => (
              <div key={currency} className="flex flex-col items-center rounded-xl bg-ink p-2">
                {amount && <p className="mb-1 select-all text-center font-mono text-[15px] font-bold text-scrim">Pay {amount} {currency}</p>}
                <QRCodeSVG value={uri} size={120} level="M" />
                <span className="mt-1 select-all break-all text-center font-mono text-[10px] text-scrim">{address}</span>
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
                    className={`break-all underline ${isSender ? 'text-ink' : 'text-blue-300'}`}
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
            className={`mt-2 block min-h-11 w-full text-left text-[15px] font-semibold underline active:scale-95 ${isSender ? 'text-ink' : 'text-blue-300'}`}
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
          <p className="text-[13px] text-ink/45">Couldn't open</p>
        )}
      </div>
    </motion.article>
    {open && (
      <div className="fixed inset-0 z-[75] flex items-end justify-center bg-scrim/70 p-3" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <div className="mb-safe w-full max-w-sm rounded-3xl border border-line bg-panel p-3" onPointerDown={(event) => event.stopPropagation()}>
          <div className="mb-2 flex justify-between rounded-2xl bg-ink/5 px-2 py-2">
            {REACTION_CHOICES.map((emoji) => (
              <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => { haptic('light'); act('react', { emoji }); }} className="text-[22px] active:scale-95">{emoji}</button>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {menuActions.map(([action, Icon, label]) => (
              <button key={action} type="button" onClick={() => { haptic('light'); act(action); }} className={`flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-[12px] font-semibold active:bg-ink/10 ${action === 'delete' ? 'text-red-400' : 'text-ink'}`}>
                <Icon size={18} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )}
      {showReactors && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-scrim/60 p-4" onClick={() => setShowReactors(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-4" onClick={(event) => event.stopPropagation()}>
            <p className="mb-3 text-[15px] font-semibold text-ink">{showReactors}</p>
            {(grouped.get(showReactors) || []).map((person) => (
              <p key={person.pubkey} className="border-b border-ink/5 py-2 text-[13px] text-ink/80">
                {noHexName(profiles[person.pubkey], person.pubkey)}
              </p>
            ))}
            <button type="button" onClick={() => setShowReactors(false)} className="mt-3 text-[13px] font-semibold text-accent">Close</button>
          </div>
        </div>
      )}
    </>
  );
}
