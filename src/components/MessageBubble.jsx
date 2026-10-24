import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { BadgeCheck, Bookmark, Copy, Radio, Reply, ShoppingBag, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { paymentUri } from '../lib/paymentUri';
import { haptic } from '../lib/haptics';

function messageText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.type === 'order_request' || data.type === 'cipher_order') {
    return `Order request${data.product?.title ? `: ${data.product.title}` : ''}`;
  }
  if (data.type === 'order_update') {
    return data.status === 'accepted'
      ? `Order accepted${data.productName ? `: ${data.productName}` : ''}`
      : `Order ${data.status || 'updated'}`;
  }
  if (data.type === 'product') return data.title || 'Product listing';
  return data.message || data.caption || '';
}

export default function MessageBubble({ message, data, onAction, senderName, isPinnedListing = false }) {
  const content = data || message?.data || {};
  const isSender = !!message?.isSender;
  const timestamp = Number(message?.timestamp);
  const validTimestamp = Number.isFinite(timestamp) ? timestamp : null;
  const actions = [
    ['reply', Reply, 'Reply'],
    ['bookmark', Bookmark, 'Save'],
    ['copy', Copy, 'Copy'],
    ['delete', Trash2, 'Delete'],
  ];
  if (content.type === 'product' && !isSender) actions.unshift(['buy_product', ShoppingBag, 'Buy']);
  if (content.type === 'product' && isSender) actions.unshift(['broadcast_product', Radio, 'Broadcast']);
  if (content.type === 'order_request' && !isSender) actions.unshift(['accept_order', BadgeCheck, 'Accept order']);
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

  const layoutId = content.type === 'product' && message?.id
    ? `order-product-${message.id}`
    : content.type === 'order_request' && content.product?.id
      ? `order-product-${content.product.id}`
      : undefined;
  const deliveryLabel = {
    sending: 'Sending…',
    queued: 'Queued · waiting for connection',
    failed: 'Failed · retrying automatically',
  }[message?.deliveryStatus];

  return (
    <motion.article
      id={message?.id ? `msg-${message.id}` : undefined}
      layout
      layoutId={layoutId}
      transition={{ layout: { duration: 0.24 } }}
      className={`flex w-full ${isSender ? 'justify-end' : 'justify-start'} px-3 py-1`}
    >
      <div className={`max-w-[84%] min-w-0 rounded-2xl px-3 py-2 ${isSender ? 'rounded-br-md bg-blue-600 text-white' : 'rounded-bl-md border border-white/10 bg-[#111] text-white'}`}>
        {!isSender && senderName && <p className="mb-1 text-[11px] font-semibold text-blue-400">{senderName}</p>}
        {content.type === 'image' && content.url && (
          <a href={content.url} target="_blank" rel="noreferrer" className="block">
            <img src={content.url} alt="Shared image" loading="lazy" className="max-h-72 max-w-full rounded-lg object-contain" />
          </a>
        )}
        {content.type === 'album' && Array.isArray(content.urls) && (
          <div className="grid grid-cols-2 gap-1">
            {content.urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                <img src={url} alt="Shared image" loading="lazy" className="h-32 w-full rounded-lg object-cover" />
              </a>
            ))}
          </div>
        )}
        {content.type === 'audio' && content.url && (
          <audio controls preload="metadata" src={content.url} className="max-w-full" />
        )}
        {content.type === 'product' && content.image && (
          <img src={content.image} alt="" loading="lazy" className="mb-2 max-h-48 rounded-lg object-cover" />
        )}
        {content.type === 'product' && isPinnedListing && (
          <p className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><BadgeCheck size={13} /> Endorsed / Pinned Listing</p>
        )}
        {paymentRows.length > 0 && (
          <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
            <p className="text-[12px] font-semibold text-white/75">Seller payment details</p>
            {paymentRows.map(([currency, address]) => (
              <div key={currency} className="flex flex-col items-center rounded-xl bg-white p-2">
                <QRCodeSVG value={paymentUri(currency, address, content.product?.price, content.product?.currency)} size={144} level="M" />
                <span className="mt-2 break-all text-center font-mono text-[10px] text-black">{address}</span>
              </div>
            ))}
          </div>
        )}
        {messageText(content) && (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{messageText(content)}</p>
        )}
        {isSender && deliveryLabel && (
          <p role="status" className={`mt-1 text-[11px] ${message?.deliveryStatus === 'failed' ? 'text-rose-300' : 'text-white/45'}`}>
            {deliveryLabel}
          </p>
        )}
        {!messageText(content) && !content.url && !content.urls && !paymentRows.length && (
          <p className="text-[13px] text-white/50">Message content unavailable</p>
        )}
        <div className="mt-1 flex items-center justify-end gap-2">
          {message?.edited && <span className="text-[10px] text-white/40">edited</span>}
          <time className="text-[10px] text-white/45" dateTime={validTimestamp === null ? undefined : new Date(validTimestamp * 1000).toISOString()}>
            {validTimestamp === null ? '' : new Date(validTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        </div>
        <div className="mt-2 flex gap-3 border-t border-white/10 pt-1">
          {actions.map(([action, Icon, label]) => (
            <button key={action} type="button" aria-label={label} title={label} onClick={() => {
              if (action === 'buy_product') haptic('light');
              onAction?.(action, message);
            }} className="p-1 text-white/45 hover:text-white">
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
    </motion.article>
  );
}
