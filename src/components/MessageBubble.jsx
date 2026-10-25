import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BadgeCheck, Bookmark, Copy, Forward, Pencil, Pin, Radio, Reply, ShoppingBag, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { paymentRowsFor } from '../lib/paymentUri';
import { haptic } from '../lib/haptics';
import { securingPhase } from '../lib/crypto/groupKeyRequest';
import { useChatStore } from '../store/chatStore';
import LinkPreview, { firstUrl } from './chat/LinkPreview';
import Picture from './ui/Picture';
import { PrivateAudio, PrivateImage } from './ui/PrivateMedia';
import { isPrivateMedia } from '../lib/mediaCrypto';
import { allowsLinkPreviews } from '../lib/privacy';

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

function orderLabel(content) {
  if (content.paymentState === 'confirmed') return { text: 'Confirmed', className: 'bg-blue-600 text-white' };
  if (content.status === 'shipped') return { text: 'Shipped', className: 'bg-blue-600 text-white' };
  if (content.status === 'delivered' || content.status === 'completed') return { text: 'Delivered', className: 'bg-emerald-500 text-white' };
  if (content.status === 'cancelled') return { text: 'Cancelled', className: 'bg-white/15 text-white' };
  if (content.status === 'disputed') return { text: 'Disputed', className: 'bg-rose-500/20 text-rose-200' };
  if (content.paymentState === 'seen' && content.paymentSeenBy !== 'vendor') return { text: 'Seen on-chain', className: 'bg-blue-600 text-white' };
  if (content.status === 'paid' || content.paymentSeenBy === 'vendor') return { text: 'Marked paid', className: 'bg-blue-600 text-white' };
  if (content.status === 'accepted' || content.paymentState === 'address_issued') return { text: 'Address sent', className: 'bg-amber-400 text-black' };
  return { text: 'Awaiting payment', className: 'bg-amber-400 text-black' };
}

function OrderReceipt({ content }) {
  const product = content.product || {};
  const title = product.title || product.name || content.productName || 'Order';
  const priceValue = product.priceUsd ?? product.price ?? content.amount ?? '';
  const currency = product.currency || content.currency || 'USD';
  const price = priceValue === '' ? '' : (currency === 'USD' ? `$${priceValue}` : `${priceValue} ${currency}`);
  const address = content.shippingAddress || content.address || content.shipTo || '';
  const pill = orderLabel(content);
  return (
    <div className="mb-1 overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl text-left">
      <Picture src={product.image} alt="" className="h-28 w-full object-cover" />
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[15px] font-semibold text-white">{title}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill.className}`}>{pill.text}</span>
        </div>
        {price && <p className="mt-1 text-[13px] font-bold text-blue-500">{price}</p>}
        {content.paymentSeenBy === 'vendor' && content.paymentState !== 'confirmed' && (
          <p className="mt-1 text-[13px] text-amber-300">Not checked on-chain.</p>
        )}
        {address && <p className="mt-1 text-[13px] text-white/40">Ship to {address}</p>}
      </div>
    </div>
  );
}

export default function MessageBubble({ message, data, onAction, senderName, isPinnedListing = false, showAvatar = false, avatarUrl = '', avatarInitial = '?' }) {
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
  const pressTimer = useRef(null);
  const pressPoint = useRef(null);
  const paymentRows = paymentRowsFor(content);
  const qrSignature = `${message?.id || ''}:${paymentRows.map((row) => row.currency).join(',')}`;
  const lastQrSignature = useRef('');

  useEffect(() => {
    if (paymentRows.length && qrSignature !== lastQrSignature.current) {
      lastQrSignature.current = qrSignature;
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([20, 40, 20]);
    }
  }, [paymentRows.length, qrSignature]);

  useEffect(() => {
    if (message?.deliveryStatus !== 'securing') return undefined;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [message?.deliveryStatus, message?.id]);

  const avatarColor = ['text-blue-400', 'text-sky-400', 'text-indigo-300', 'text-cyan-300'][(message?.pubkey?.charCodeAt(0) || 0) % 4];
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
    ? <span className={read ? 'text-blue-400' : 'text-white/45'}>{read ? '✓✓' : '✓'}</span>
    : null;
  const timeLabel = validTimestamp === null ? '' : new Date(validTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const time = (
    <span className="float-right ml-2 mt-[5px] inline-flex items-center gap-1 text-[10px] leading-none text-white/45">
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
    ['forward', Forward, 'Forward'],
    ['bookmark', Bookmark, 'Save'],
    ...(inGroup ? [['pin', Pin, 'Pin']] : []),
    ...(content.type === 'product' && !isSender ? [['buy_product', ShoppingBag, 'Buy']] : []),
    ...(content.type === 'product' && isSender ? [['broadcast_product', Radio, 'Share']] : []),
    ...((content.type === 'order_request' || content.type === 'cipher_order') && !isSender ? [['accept_order', BadgeCheck, 'Accept']] : []),
    ...(isSender && text ? [['edit', Pencil, 'Edit']] : []),
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
        className={`max-w-[78%] min-w-[4.5rem] rounded-2xl border px-3 py-2 ${isSender ? 'border-blue-500 bg-blue-600 text-white' : 'border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl text-white'}`}
      >
        {!isSender && senderName && <p className="mb-0.5 text-[11px] font-semibold leading-none text-blue-400">{senderName}</p>}
        {(content.type === 'cipher_order' || content.type === 'order_request' || content.type === 'order_update') && (
          <OrderReceipt content={content} />
        )}
        {(content.type === 'cipher_order' || content.type === 'order_request') && !isSender && content.status !== 'accepted' && content.status !== 'cancelled' && (
          <button type="button" onClick={(event) => { event.stopPropagation(); onAction?.('accept_order', { ...message, data: content }); }} className="mb-1 min-h-11 text-left text-[15px] font-semibold text-blue-300">Accept order</button>
        )}
        {(content.type === 'cipher_order' || content.type === 'order_request') && !isSender && content.status === 'accepted' && content.paymentState !== 'confirmed' && content.paymentSeenBy !== 'vendor' && (
          <button type="button" onClick={(event) => { event.stopPropagation(); onAction?.('confirm_payment', { ...message, data: content }); }} className="mb-1 min-h-11 text-left text-[15px] font-semibold text-white">I saw the payment</button>
        )}
        {(content.type === 'cipher_order' || content.type === 'order_request') && !isSender && (content.status === 'accepted' || content.paymentState === 'seen' || content.paymentState === 'address_issued') && content.paymentState !== 'confirmed' && (
          <button type="button" onClick={(event) => { event.stopPropagation(); onAction?.('check_chain', { ...message, data: content }); }} className="mb-1 min-h-11 text-left text-[15px] font-semibold text-white">Check the chain</button>
        )}
        {content.type === 'image' && (isPrivateMedia(content)
          ? <PrivateImage entry={content} className="max-h-64 max-w-full rounded-xl object-contain" />
          : <Picture src={content.url} link alt="Shared image" loading="lazy" className="max-h-64 max-w-full rounded-xl object-contain" />
        )}
        {content.type === 'album' && Array.isArray(content.media) && (
          <div className="grid grid-cols-2 gap-1">
            {content.media.filter(isPrivateMedia).map((entry) => (
              <PrivateImage key={entry.url} entry={entry} className="h-28 w-full rounded-lg object-cover" />
            ))}
          </div>
        )}
        {content.type === 'album' && !Array.isArray(content.media) && Array.isArray(content.urls) && (
          <div className="grid grid-cols-2 gap-1">
            {content.urls.map((url) => (
              <Picture key={url} src={url} link alt="Shared image" loading="lazy" className="h-28 w-full rounded-lg object-cover" />
            ))}
          </div>
        )}
        {content.type === 'audio' && content.url && (isPrivateMedia(content)
          ? <PrivateAudio entry={content} className="h-8 max-w-full" />
          : <audio controls preload="metadata" src={content.url} className="h-8 max-w-full" onClick={(event) => event.stopPropagation()} />
        )}
        {content.type === 'product' && <Picture src={content.image} alt="" loading="lazy" className="mb-1 max-h-40 rounded-xl object-cover" />}
        {content.type === 'product' && isPinnedListing && (
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><BadgeCheck size={12} /> Pinned</p>
        )}
        {paymentRows.length > 0 && (
          <div className="mb-1 space-y-2">
            {paymentRows.map(({ currency, address, amount, uri }) => (
              <div key={currency} className="flex flex-col items-center rounded-xl bg-white p-2">
                {amount && <p className="mb-1 select-all text-center font-mono text-[15px] font-bold text-black">Pay {amount} {currency}</p>}
                <QRCodeSVG value={uri} size={120} level="M" />
                <span className="mt-1 select-all break-all text-center font-mono text-[10px] text-black">{address}</span>
              </div>
            ))}
          </div>
        )}
        {text ? (
          <p className="whitespace-pre-wrap break-words text-[14.5px] leading-[1.28]">
            {text}
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
            className={`mt-2 block min-h-11 w-full text-left text-[15px] font-semibold underline active:scale-95 ${isSender ? 'text-white' : 'text-blue-300'}`}
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
                className="rounded-full border border-white/10 bg-black/40 px-1.5 py-0.5 text-[12px] text-white"
              >
                {emoji} {people.length}
              </motion.button>
            ))}
          </div>
        )}
        {!text && !content.url && !content.urls && !content.media && !paymentRows.length && !['image', 'audio', 'product', 'cipher_order', 'order_request', 'order_update', 'text'].includes(content.type) && (
          <p className="text-[13px] text-white/45">Couldn't open</p>
        )}
      </div>
    </motion.article>
    {open && (
      <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/70 p-3" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <div className="mb-safe w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-3" onPointerDown={(event) => event.stopPropagation()}>
          <div className="mb-2 flex justify-between rounded-2xl bg-white/5 px-2 py-2">
            {REACTION_CHOICES.map((emoji) => (
              <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => { haptic('light'); act('react', { emoji }); }} className="text-[22px] active:scale-95">{emoji}</button>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {menuActions.map(([action, Icon, label]) => (
              <button key={action} type="button" onClick={() => { haptic('light'); act(action); }} className={`flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-[12px] font-semibold active:bg-white/10 ${action === 'delete' ? 'text-red-400' : 'text-white'}`}>
                <Icon size={18} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )}
      {showReactors && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-4" onClick={() => setShowReactors(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-4" onClick={(event) => event.stopPropagation()}>
            <p className="mb-3 text-[15px] font-semibold text-white">{showReactors}</p>
            {(grouped.get(showReactors) || []).map((person) => (
              <p key={person.pubkey} className="border-b border-white/5 py-2 text-[13px] text-white/80">
                {profiles[person.pubkey]?.displayName || profiles[person.pubkey]?.name || `${person.pubkey.slice(0, 8)}…`}
              </p>
            ))}
            <button type="button" onClick={() => setShowReactors(false)} className="mt-3 text-[13px] font-semibold text-blue-500">Close</button>
          </div>
        </div>
      )}
    </>
  );
}
