import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import GroupInfoSidebar from './GroupInfoSidebar';
import { useChatStore } from '../../store/chatStore';
import { db, saveMessage } from '../../db';
import { scopedRemove } from '../../lib/storage';
import { useNIP29Group, loadGroupProfile } from '../../hooks/useNIP29Group';

function GroupStorefront({ items, pinnedId, canList, onBuy, onList }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const featured = items.find((item) => item.message.id === pinnedId);
  const rest = items.filter((item) => item.message.id !== pinnedId);
  const card = (item, featuredCard) => (
    <button
      key={item.message.id}
      type="button"
      onClick={() => onBuy(item)}
      className={`flex w-full items-center gap-3 border-b border-white/5 px-4 py-3 text-left active:bg-white/10 ${featuredCard ? 'bg-amber-300/[0.07]' : 'bg-black'}`}
    >
      {item.product.image && <img src={item.product.image} alt="" className="h-12 w-12 object-cover" />}
      <span className="min-w-0 flex-1">
        {featuredCard && <span className="block text-[11px] font-semibold uppercase tracking-wide text-amber-200">Pin slot</span>}
        <span className="block truncate text-[15px] font-semibold text-white">{item.product.title || item.product.name || 'Item'}</span>
        <span className="block text-[13px] font-bold text-blue-500">{item.product.priceUsd ? `$${item.product.priceUsd}` : (item.product.price || 'Ask')}</span>
      </span>
    </button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {featured && card(featured, true)}
      {rest.map((item) => card(item, false))}
      {items.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-white/40">No listings yet.</p>}
      {canList && !open && <button type="button" onClick={() => setOpen(true)} className="w-full border-b border-white/5 px-4 py-4 text-left text-[15px] font-semibold text-blue-500 active:bg-white/10">List an item</button>}
      {canList && open && (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || !price.trim()) return;
          onList({ title: title.trim(), priceUsd: price.trim(), description: note.trim(), currency: 'USD' });
          setTitle(''); setPrice(''); setNote(''); setOpen(false);
        }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Item" className="w-full border-b border-white/5 bg-black px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
          <input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Price in USD" inputMode="decimal" className="w-full border-b border-white/5 bg-black px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note" className="w-full border-b border-white/5 bg-black px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
          <button type="submit" className="w-full px-4 py-4 text-left text-[15px] font-semibold text-blue-500">Post to shop</button>
        </form>
      )}
    </div>
  );
}

const EMPTY_MESSAGES = [];

function readPayload(message) {
  if (message?.data && typeof message.data === 'object') return message.data;
  if (typeof message?.data === 'string') return { type: 'text', message: message.data };
  if (typeof message?.rawContent !== 'string' || message.rawContent.length === 0) return null;
  try {
    const parsed = JSON.parse(message.rawContent);
    if (typeof parsed === 'string') return { type: 'text', message: parsed };
    if (parsed && typeof parsed === 'object') {
      if (!parsed.type && typeof parsed.message === 'string') return { ...parsed, type: 'text' };
      return parsed;
    }
  } catch {
    return { type: 'text', message: message.rawContent };
  }
  return { type: 'text', message: message.rawContent };
}

function disappearingSeconds(timer) {
  if (!timer || timer === 'off') return 0;
  if (String(timer).endsWith('m')) return (parseInt(timer, 10) || 0) * 60;
  if (timer === '1h') return 3600;
  if (timer === '24h') return 86400;
  if (timer === '7d') return 604800;
  return 0;
}

export default function GroupView({
  identity,
  sendMessage,
  handleMessageAction,
  handleImageUpload,
  startRecording,
  stopRecording,
  fetchGroupMembers,
  fetchPinnedMessage,
  pinMessage,
  unpinMessage,
}) {
  const { sendGroupMessage, leaveGroup, kickMember, updateGroupSettings } = useNIP29Group({ identity });
  const activeGroup = useChatStore((state) => state.activeGroup);
  const messages = useChatStore((state) => state.groupMessages[state.activeGroup?.id] || EMPTY_MESSAGES);
  const profiles = useChatStore((state) => state.profiles);
  const deletedMsgs = useChatStore((state) => state.deletedMsgs);
  const pinnedMessageId = useChatStore((state) => state.pinnedMessages[state.activeGroup?.id]);
  const showGroupInfo = useChatStore((state) => state.showGroupInfo);
  const setShowGroupInfo = useChatStore((state) => state.setShowGroupInfo);
  const replyingTo = useChatStore((state) => state.replyingTo);
  const setReplyingTo = useChatStore((state) => state.setReplyingTo);
  const scrollRef = useRef(null);
  const [pane, setPane] = useState('chat');
  const isVendor = useChatStore((state) => state.isVendor);
  const setToast = useChatStore((state) => state.setToast);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, activeGroup?.id]);

  useEffect(() => {
    if (!activeGroup?.id || !identity?.pk) return undefined;
    let cancelled = false;
    loadGroupProfile(identity, activeGroup.id, activeGroup.name).then((profile) => {
      if (cancelled || !profile?.id) return;
      const current = useChatStore.getState().activeGroup;
      if (current?.id === profile.id && (current.name !== profile.name || current.picture !== profile.picture)) {
        useChatStore.getState().setActiveGroup({ ...current, ...profile });
      }
      useChatStore.getState().setGroups((groups) => {
        const list = Array.isArray(groups) ? groups : [];
        const existing = list.find((group) => group.id === profile.id);
        if (existing && existing.name === profile.name && (existing.picture || '') === (profile.picture || '') && (existing.about || '') === (profile.about || '')) {
          return list;
        }
        return list.map((group) => (group.id === profile.id ? { ...group, ...profile } : group));
      });
    }).catch((error) => console.warn('[GroupView] Group name lookup failed:', error));
    return () => { cancelled = true; };
  }, [activeGroup?.id, identity?.pk]);

  useEffect(() => {
    if (activeGroup?.id) {
      fetchPinnedMessage(activeGroup.id).catch((error) => {
        console.error('[GroupView] Could not fetch pinned listing:', error);
      });
    }
  }, [activeGroup?.id, fetchPinnedMessage]);

  const sendGroupText = async (text) => {
    const groupId = activeGroup?.id;
    if (!groupId) return;
    const replyId = replyingTo?.id || null;
    const payload = { type: 'text', message: text };
    const seconds = disappearingSeconds(useChatStore.getState().disappearingTimers?.[groupId]);
    if (seconds > 0) payload.expires_at = Math.floor(Date.now() / 1000) + seconds;
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      clientId: tempId,
      isSender: true,
      pubkey: identity?.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      replyTo: replyId,
      deliveryStatus: 'sending',
      rawContent: JSON.stringify(payload),
      isGroup: true,
    };
    useChatStore.getState().setGroupMessages((prev) => ({
      ...prev,
      [groupId]: [...(prev[groupId] || []), optimistic],
    }));
    await saveMessage(groupId, optimistic);
    const result = await sendGroupMessage(groupId, payload, tempId, replyId);
    if (!result?.success) {
      useChatStore.getState().setGroupMessages((prev) => ({
        ...prev,
        [groupId]: (prev[groupId] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
      }));
      try { await db.messages.delete(tempId); } catch (error) { console.error('[GroupView] Failed to remove unsent message:', error); }
      useChatStore.getState().setToast({
        type: 'error',
        message: result?.error === 'NO_KEY' ? 'Securing group... please try again in a moment.' : 'Failed to send to group',
      });
      throw new Error(result?.error || 'Failed to send to group');
    }
    if (result.event?.id) {
      let confirmed = null;
      useChatStore.getState().setGroupMessages((prev) => ({
        ...prev,
        [groupId]: (prev[groupId] || []).map((message) => {
          if (message.clientId !== tempId) return message;
          confirmed = {
            ...message,
            id: result.event.id,
            timestamp: result.event.created_at,
            deliveryStatus: result.queued ? 'queued' : 'sent',
          };
          return confirmed;
        }),
      }));
      if (confirmed) await saveMessage(groupId, confirmed);
    }
    setReplyingTo(null);
    scopedRemove(`draft-group-${groupId}`);
    return result;
  };

  const visibleMessages = messages.filter((message) => !(deletedMsgs instanceof Set && deletedMsgs.has(message.id)));
  const shopItems = visibleMessages
    .map((message) => ({ message, product: readPayload(message) }))
    .filter(({ product }) => product?.type === 'product' && !product.soldOut);
  const canList = isVendor || activeGroup?.creator === identity?.pk;
  const postListing = async (product) => {
    if (!activeGroup?.id) return;
    try {
      const result = await sendGroupMessage(activeGroup.id, { type: 'product', ...product });
      if (result?.success === false) setToast({ type: 'error', message: 'Could not post that listing.' });
    } catch (error) {
      console.error('[shop] listing failed:', error);
      setToast({ type: 'error', message: 'Could not post that listing.' });
    }
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-black">
      <ChatHeader mode="group" />
      <div className="grid grid-cols-2 border-b border-white/10">
        {[['chat', 'Chat'], ['shop', 'Shop']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setPane(id)} className={`py-2.5 text-[13px] font-semibold ${pane === id ? 'border-b-2 border-blue-600 text-white' : 'text-white/40'}`}>{label}</button>
        ))}
      </div>
      {pane === 'shop' ? (
        <GroupStorefront
          items={shopItems}
          pinnedId={pinnedMessageId}
          canList={canList}
          onBuy={({ message, product }) => handleMessageAction?.('buy_product', { ...message, data: product })}
          onList={postListing}
        />
      ) : (
      <>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-3">
        {visibleMessages.length === 0 ? (
          <div className="m-auto max-w-[16rem] px-6 text-center">
            <p className="text-[15px] font-semibold text-white">You're in {activeGroup?.name || 'this group'}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-white/40">Say hello. Messages stay in this chat, with a name and a time on every one.</p>
          </div>
        ) : visibleMessages.map((message) => {
          const data = message.pending ? null : readPayload(message);
          const senderProfile = profiles[message.pubkey];
          return (
            <MessageBubble
              key={message.clientId || message.id}
              message={message}
              data={data || { type: 'text', message: message.pending ? 'Waiting for group encryption key…' : (typeof message.rawContent === 'string' && message.rawContent && !message.rawContent.startsWith('{') ? message.rawContent : 'Message unavailable') }}
              senderName={message.isSender ? null : (senderProfile?.displayName || senderProfile?.name || message.pubkey?.slice(0, 8))}
              showAvatar={!message.isSender}
              avatarUrl={senderProfile?.picture}
              avatarInitial={senderProfile?.displayName?.charAt(0) || '?'}
              isPinnedListing={message.id === pinnedMessageId}
              onAction={handleMessageAction}
            />
          );
        })}
      </div>
      {replyingTo && (
        <div className="flex items-center gap-3 border-t border-white/10 bg-[#111] px-4 py-2">
          <div className="min-w-0 flex-1 border-l-2 border-blue-500 pl-3">
            <p className="text-[11px] font-semibold text-blue-400">{replyingTo.isSender ? 'You' : 'Replying'}</p>
            <p className="truncate text-[13px] text-white/60">{replyingTo.data?.message || replyingTo.rawContent || 'Message'}</p>
          </div>
          <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="p-2 text-white/45 hover:text-white"><X size={18} /></button>
        </div>
      )}
      <div className="pb-safe">
        <MessageInput sendMessage={sendGroupText || sendMessage} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} />
      </div>
      </>
      )}
      <GroupInfoSidebar
        isOpen={showGroupInfo}
        onClose={() => setShowGroupInfo(false)}
        identity={identity}
        fetchGroupMembers={fetchGroupMembers}
        fetchPinnedMessage={fetchPinnedMessage}
        onPin={pinMessage}
        onUnpin={unpinMessage}
        leaveGroup={leaveGroup}
        kickMember={kickMember}
        updateGroupSettings={updateGroupSettings}
      />
    </section>
  );
}
