import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import GroupInfoSidebar from './GroupInfoSidebar';
import { useChatStore } from '../../store/chatStore';
import { db, saveMessage } from '../../db';
import { scopedRemove } from '../../lib/storage';
import { useNIP29Group, loadGroupProfile, retrySecuringGroup } from '../../hooks/useNIP29Group';
import { securingPhase, securingSendsFor } from '../../lib/crypto/groupKeyRequest';
import { haptic } from '../../lib/haptics';
import { noHexName } from '../../lib/npub';
import { stampArrival } from '../../features/chat/media';
import Picture from '../ui/Picture';

function GroupStorefront({ items, pinnedId, canList, onBuy, onList, pendingLists = [], now = 0, onRetrySecure }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const money = (product) => {
    const amount = product.priceUsd ?? product.price ?? '';
    if (amount === '' || amount == null) return 'Ask';
    const currency = product.currency || (product.priceUsd != null && product.priceUsd !== '' ? 'USD' : '');
    if (!currency || currency === 'USD') return `$${amount}`;
    return `${amount} ${currency}`;
  };
  const featured = items.find((item) => item.message.id === pinnedId);
  const rest = items.filter((item) => item.message.id !== pinnedId);
  const card = (item, featuredCard) => (
    <button
      key={item.message.id}
      type="button"
      onClick={() => onBuy(item)}
      className={`flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5 ${featuredCard ? 'bg-amber-300/[0.07]' : ''}`}
    >
      <Picture src={item.product.image} alt="" className="h-12 w-12 object-cover" fallback={<span className="flex h-12 w-12 items-center justify-center bg-white/5 text-[11px] text-white/30">Item</span>} />
      <span className="min-w-0 flex-1">
        {featuredCard && <span className="block text-[11px] font-semibold uppercase tracking-wide text-amber-200">Pinned</span>}
        <span className="block truncate text-[15px] font-semibold text-white">{item.product.title || item.product.name || 'Item'}</span>
        <span className="block text-[13px] font-bold text-accent">{money(item.product)}</span>
      </span>
    </button>
  );
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
      {featured && card(featured, true)}
      {rest.map((item) => card(item, false))}
      {items.length === 0 && pendingLists.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-white/40">No listings yet.</p>}
      </div>
      {pendingLists.map((item) => {
        const stuck = securingPhase(item.since, now) === 'stuck';
        const name = item.payload?.title || item.payload?.name || 'Listing';
        return (
          <div key={item.id} className="rounded-2xl border border-line bg-panel px-4 py-3 shadow-lg">
            <p className="text-[15px] font-semibold text-white">{name}</p>
            {stuck ? (
              <button type="button" onClick={() => onRetrySecure?.()} className="mt-1 block min-h-11 text-left text-[15px] font-semibold text-blue-300 underline active:scale-95">
                Still securing — retry
              </button>
            ) : (
              <p className="mt-1 text-[13px] text-white/40">Securing…</p>
            )}
          </div>
        );
      })}
      {canList && !open && <button type="button" onClick={() => setOpen(true)} className="w-full rounded-2xl bg-accent py-3.5 font-bold text-accentInk">List an item</button>}
      {canList && open && (
        <form onSubmit={(event) => {
          event.preventDefault();
          const amount = Number(price);
          if (!title.trim()) { setFormError('Add a name.'); return; }
          if (!Number.isFinite(amount) || amount <= 0) { setFormError('Enter a price greater than 0.'); return; }
          setFormError('');
          onList({ title: title.trim(), priceUsd: amount, description: note.trim(), currency: 'USD' });
          setTitle(''); setPrice(''); setNote(''); setOpen(false);
        }} className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Item" className="w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
          <input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Price in USD" inputMode="decimal" className="w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note" className="w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
          <button type="submit" className="w-full bg-accent py-3.5 font-bold text-accentInk">Post to shop</button>
          {formError && <p role="alert" className="px-4 py-3 text-[13px] text-red-400">{formError}</p>}
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
  if (timer === '30d') return 2592000;
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
  const { sendGroupMessage, leaveGroup, kickMember, updateGroupSettings, addMember } = useNIP29Group({ identity });
  const activeGroup = useChatStore((state) => state.activeGroup);
  const messages = useChatStore((state) => state.groupMessages[state.activeGroup?.id] || EMPTY_MESSAGES);
  const profiles = useChatStore((state) => state.profiles);
  const members = useChatStore((state) => state.groupMembers);
  // S9: only a creator or admin may pin, matching the standing check the
  // group hook applies before a kind-9005 event is even sent.
  const canManage = activeGroup?.creator === identity?.pk
    || (Array.isArray(members) ? members : []).some((member) => (
      member.pubkey === identity?.pk && ['admin', 'owner'].includes(member.role)
    ));
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
  const [pendingLists, setPendingLists] = useState([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, activeGroup?.id]);

  useEffect(() => {
    if (!identity?.pk || !activeGroup?.id) return undefined;
    const refresh = () => {
      const pending = securingSendsFor(identity.pk, activeGroup.id).filter((item) => item.payload?.type === 'product');
      setPendingLists((prev) => {
        const same = prev.length === pending.length && prev.every((item, index) => item.id === pending[index].id && item.since === pending[index].since);
        return same ? prev : pending;
      });
      if (pending.length) setNow(Date.now());
    };
    refresh();
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [identity?.pk, activeGroup?.id, messages]);

  const retrySecure = async () => {
    if (!activeGroup?.id) return;
    haptic('light');
    const since = Date.now();
    useChatStore.getState().setGroupMessages((prev) => ({
      ...prev,
      [activeGroup.id]: (prev[activeGroup.id] || []).map((message) => (
        message.deliveryStatus === 'securing' ? { ...message, securingSince: since } : message
      )),
    }));
    try {
      await retrySecuringGroup(identity, activeGroup.id);
      setToast({ type: 'success', message: 'Retrying…' });
    } catch (error) {
      console.error('[group] retry failed:', error);
      setToast({ type: 'error', message: 'Could not retry.' });
    }
  };

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
    const optimistic = stampArrival({
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
    });
    useChatStore.getState().setGroupMessages((prev) => ({
      ...prev,
      [groupId]: [...(prev[groupId] || []), optimistic],
    }));
    await saveMessage(groupId, optimistic);
    const result = await sendGroupMessage(groupId, payload, tempId, replyId);
    if (!result?.success) {
      if (result?.error === 'NO_KEY') {
        const securing = { ...optimistic, deliveryStatus: 'securing', securingSince: Date.now(), pending: false };
        useChatStore.getState().setGroupMessages((prev) => ({
          ...prev,
          [groupId]: (prev[groupId] || []).map((message) => (
            message.id === tempId || message.clientId === tempId ? securing : message
          )),
        }));
        await saveMessage(groupId, securing);
        return result;
      }
      useChatStore.getState().setGroupMessages((prev) => ({
        ...prev,
        [groupId]: (prev[groupId] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
      }));
      try { await db.messages.delete(tempId); } catch (error) { console.error('[GroupView] Failed to remove unsent message:', error); }
      useChatStore.getState().setToast({ type: 'error', message: 'Failed to send to group' });
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
      if (result?.error === 'NO_KEY') setToast({ type: 'success', message: 'Securing… the listing will send when the group key arrives.' });
      else if (result?.success === false) setToast({ type: 'error', message: 'Could not post that listing.' });
    } catch (error) {
      console.error('[shop] listing failed:', error);
      setToast({ type: 'error', message: 'Could not post that listing.' });
    }
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ChatHeader mode="group" />
      <div className="grid grid-cols-2 border-b border-white/5 px-4">
        {[['chat', 'Chat'], ['shop', 'Shop']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setPane(id)} className={`py-2.5 text-[13px] font-semibold ${pane === id ? 'border-b-2 border-accent text-white' : 'text-white/40'}`}>{label}</button>
        ))}
      </div>
      {pane === 'shop' ? (
        <GroupStorefront
          items={shopItems}
          pinnedId={pinnedMessageId}
          canList={canList}
          pendingLists={pendingLists}
          now={now}
          onRetrySecure={retrySecure}
          onBuy={({ message, product }) => handleMessageAction?.('buy_product', { ...message, data: product })}
          onList={postListing}
        />
      ) : (
      <>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-3">
        {visibleMessages.length === 0 ? (
          <div className="m-auto mx-4 max-w-sm rounded-2xl border border-line bg-panel shadow-lg px-4 py-8 text-center">
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
              senderName={message.isSender ? null : noHexName(senderProfile, message.pubkey)}
              showAvatar={!message.isSender}
              avatarUrl={senderProfile?.picture}
              avatarInitial={senderProfile?.displayName?.charAt(0) || '?'}
              isPinnedListing={message.id === pinnedMessageId}
              canPin={canManage}
              onAction={handleMessageAction}
            />
          );
        })}
      </div>
      {replyingTo && (
        <div className="mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-4 py-3">
          <div className="min-w-0 flex-1 border-l-2 border-accent pl-3">
            <p className="text-[11px] font-semibold text-accent">{replyingTo.isSender ? 'You' : 'Replying'}</p>
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
      </div>
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
        approveJoin={addMember}
        updateGroupSettings={updateGroupSettings}
      />
    </section>
  );
}
