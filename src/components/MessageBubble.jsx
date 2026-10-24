import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BadgeCheck, Bookmark, Copy, Forward, Pencil, Pin, Radio, Reply, ShoppingBag, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { paymentUri } from '../lib/paymentUri';
import { haptic } from '../lib/haptics';
import { useChatStore } from '../store/chatStore';
import LinkPreview, { firstUrl } from './chat/LinkPreview';

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

function orderLabel(status) {
  if (status === 'accepted') return { text: 'Accepted', className: 'bg-blue-600 text-white' };
  if (status === 'paid' || status === 'confirmed') return { text: 'Paid', className: 'bg-blue-600 text-white' };
  if (status === 'shipped') return { text: 'Shipped', className: 'bg-blue-600 text-white' };
  if (status === 'delivered') return { text: 'Delivered', className: 'bg-emerald-500 text-white' };
  if (status === 'cancelled') return { text: 'Cancelled', className: 'bg-white/15 text-white' };
  return { text: 'Awaiting Payment', className: 'bg-amber-400 text-black' };
}

function OrderReceipt({ content }) {
  const product = content.product || {};
  const title = product.title || product.name || content.productName || 'Order';
  const priceValue = product.priceUsd ?? product.price ?? content.amount ?? '';
  const currency = product.currency || content.currency || 'USD';
  const price = priceValue === '' ? '' : (currency === 'USD' ? `$${priceValue}` : `${priceValue} ${currency}`);
  const address = content.shippingAddress || content.address || content.shipTo || '';
  const pill = orderLabel(content.status);
  return (
    <div className="mb-1 overflow-hidden rounded-2xl border border-white/10 bg-[#111] text-left">
      {product.image && <img src={product.image} alt="" className="h-28 w-full object-cover" />}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[15px] font-semibold text-white">{title}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill.className}`}>{pill.text}</span>
        </div>
        {price && <p className="mt-1 text-[13px] font-bold text-blue-500">{price}</p>}
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
  const mountedAt = useRef(Date.now() / 1000);
  const deleted = useChatStore((state) => state.deletedMsgs);
  const reactions = useChatStore((state) => (message?.id ? state.reactions[message.id] : undefined)) || EMPTY_REACTIONS;
  const profiles = useChatStore((state) => state.profiles);
  const inGroup = useChatStore((state) => !!state.activeGroup);
  const pressTimer = useRef(null);
  const pressPoint = useRef(null);
  const paymentMethods = content.type === 'order_update' && content.status === 'accepted' ? content.paymentMethods || {} : {};
  const paymentRows = [
    ['BTC', paymentMethods.btc],
    ['XMR', paymentMethods.xmr],
  ].filter(([, address]) => address);
  const qrSignature = `${message?.id || ''}:${paymentRows.map(([currency]) => currency).join(',')}`;
  const lastQrSignature = useRef('');

  useEffect(() => {
    if (paymentRows.length && qrSignature !== lastQrSignature.current) {
      lastQrSignature.current = qrSignature;
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([20, 40, 20]);
    }
  }, [paymentRows.length, qrSignature]);

  const avatarColor = ['text-blue-400', 'text-sky-400', 'text-indigo-300', 'text-cyan-300'][(message?.pubkey?.charCodeAt(0) || 0) % 4];
  const deliveryLabel = {
    sending: 'Sending',
    queued: 'Queued',
    failed: 'Failed',
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
        avatarUrl ? (
          <img src={avatarUrl} alt="" className="mb-0.5 h-7 w-7 shrink-0 rounded-full object-cover" />
        ) : (
          <span className={`mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#161616] text-[11px] font-semibold ${avatarColor}`}>{avatarInitial}</span>
        )
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
        className={`max-w-[78%] min-w-[4.5rem] rounded-2xl border px-3 py-2 ${isSender ? 'border-blue-500 bg-blue-600 text-white' : 'border-white/10 bg-[#111] text-white'}`}
      >
        {!isSender && senderName && <p className="mb-0.5 text-[11px] font-semibold leading-none text-blue-400">{senderName}</p>}
        {(content.type === 'cipher_order' || content.type === 'order_request' || content.type === 'order_update') && (
          <OrderReceipt content={content} />
        )}
        {(content.type === 'cipher_order' || content.type === 'order_request') && !isSender && content.status !== 'accepted' && (
          <button type="button" onClick={(event) => { event.stopPropagation(); onAction?.('accept_order', { ...message, data: content }); }} className="mb-1 text-[13px] font-semibold text-blue-400">Accept order</button>
        )}
        {content.type === 'image' && content.url && (
          <a href={content.url} target="_blank" rel="noreferrer" className="block" onClick={(event) => event.stopPropagation()}>
            <img src={content.url} alt="Shared image" loading="lazy" className="max-h-64 max-w-full rounded-xl object-contain" />
          </a>
        )}
        {content.type === 'album' && Array.isArray(content.urls) && (
          <div className="grid grid-cols-2 gap-1">
            {content.urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                <img src={url} alt="Shared image" loading="lazy" className="h-28 w-full rounded-lg object-cover" />
              </a>
            ))}
          </div>
        )}
        {content.type === 'audio' && content.url && (
          <audio controls preload="metadata" src={content.url} className="h-8 max-w-full" onClick={(event) => event.stopPropagation()} />
        )}
        {content.type === 'product' && content.image && (
          <img src={content.image} alt="" loading="lazy" className="mb-1 max-h-40 rounded-xl object-cover" />
        )}
        {content.type === 'product' && isPinnedListing && (
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><BadgeCheck size={12} /> Pinned</p>
        )}
        {paymentRows.length > 0 && (
          <div className="mb-1 space-y-2">
            {paymentRows.map(([currency, address]) => (
              <div key={currency} className="flex flex-col items-center rounded-xl bg-white p-2">
                <QRCodeSVG value={paymentUri(currency, address, content.product?.price, content.product?.currency)} size={120} level="M" />
                <span className="mt-1 break-all text-center font-mono text-[10px] text-black">{address}</span>
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
        {previewUrl && <LinkPreview url={previewUrl} />}
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
        {!text && !content.url && !content.urls && !paymentRows.length && !['image', 'audio', 'product', 'cipher_order', 'order_request', 'order_update', 'text'].includes(content.type) && (
          <p className="text-[13px] text-white/45">Couldn't open</p>
        )}
      </div>
    </motion.article>
    {open && (
      <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/70 p-3" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <div className="mb-safe w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-3" onPointerDown={(event) => event.stopPropagation()}>
          <div className="mb-2 flex justify-between rounded-2xl bg-[#111] px-2 py-2">
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
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0A0A0A] p-4" onClick={(event) => event.stopPropagation()}>
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
