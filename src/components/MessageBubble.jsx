import React, { useEffect, useRef, useState } from 'react';
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

export default function MessageBubble({ message, data, onAction, senderName, isPinnedListing = false, showAvatar = false, avatarUrl = '', avatarInitial = '?' }) {
  const content = data || message?.data || {};
  const text = messageText(content) || (typeof message?.rawContent === 'string' && !message.rawContent.startsWith('{') ? message.rawContent : '');
  const isSender = !!message?.isSender;
  const timestamp = Number(message?.timestamp);
  const validTimestamp = Number.isFinite(timestamp) ? timestamp : null;
  const [open, setOpen] = useState(false);
  const actions = [
    ['reply', Reply, 'Reply'],
    ['bookmark', Bookmark, 'Save'],
    ['copy', Copy, 'Copy'],
    ['delete', Trash2, 'Delete'],
  ];
  if (content.type === 'product' && !isSender) actions.unshift(['buy_product', ShoppingBag, 'Buy']);
  if (content.type === 'product' && isSender) actions.unshift(['broadcast_product', Radio, 'Broadcast']);
  if ((content.type === 'order_request' || content.type === 'cipher_order') && !isSender) actions.unshift(['accept_order', BadgeCheck, 'Accept order']);
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
  const timeLabel = validTimestamp === null ? '' : new Date(validTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const time = (
    <span className="float-right ml-2 mt-[5px] inline-flex items-center gap-1 text-[10px] leading-none text-white/45">
      {message?.edited && <span>edited</span>}
      {isSender && deliveryLabel && <span className={message?.deliveryStatus === 'failed' ? 'text-rose-200' : ''}>{deliveryLabel}</span>}
      <time dateTime={validTimestamp === null ? undefined : new Date(validTimestamp * 1000).toISOString()}>{timeLabel}</time>
    </span>
  );

  return (
    <article
      id={message?.id ? `msg-${message.id}` : undefined}
      className={`flex w-full items-end gap-1.5 px-2 ${isSender ? 'justify-end' : 'justify-start'} py-[1px]`}
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
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'Enter') setOpen((value) => !value); }}
        className={`max-w-[78%] min-w-[4.5rem] rounded-[18px] px-2.5 py-1 ${isSender ? 'rounded-br-[5px] bg-blue-600 text-white' : 'rounded-bl-[5px] bg-[#1c1c1e] text-white'}`}
      >
        {!isSender && senderName && <p className="mb-0.5 text-[11px] font-semibold leading-none text-blue-400">{senderName}</p>}
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
        {!text && !content.url && !content.urls && !paymentRows.length && content.type !== 'image' && content.type !== 'audio' && content.type !== 'product' && (
          <p className="text-[14px] leading-snug text-white/55">Message unavailable</p>
        )}
        {open && (
          <div className="mt-1 flex gap-2.5 border-t border-white/10 pt-1">
            {actions.map(([action, Icon, label]) => (
              <button key={action} type="button" aria-label={label} title={label} onClick={(event) => {
                event.stopPropagation();
                if (action === 'buy_product') haptic('light');
                onAction?.(action, message);
                setOpen(false);
              }} className="text-white/70 hover:text-white">
                <Icon size={13} />
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
