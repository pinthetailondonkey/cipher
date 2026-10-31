import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import GroupInfoSidebar from './GroupInfoSidebar';
import ThreadScroll, { SelectBar } from './ThreadScroll';
import ForwardPicker from './ForwardPicker';
import { useThreadActions } from './useThreadActions';
import { useChatStore } from '../../store/chatStore';
import { db, saveMessage } from '../../db';
import { scopedRemove } from '../../lib/storage';
import { useNIP29Group, loadGroupProfile, retrySecuringGroup } from '../../hooks/useNIP29Group';
import { mergeGroupProfile } from '../../lib/groupJoin';
import { securingPhase, securingSendsFor } from '../../lib/crypto/groupKeyRequest';
import { haptic } from '../../lib/haptics';
import { noHexName } from '../../lib/npub';
import { stampArrival } from '../../features/chat/media';
import { sendOutcome } from '../../lib/sendOutcome';
import { uploadAttachment, photoRefusalToast } from '../../lib/mediaCrypto';
import { blossomServers } from '../../lib/egress';
import { ProductImage } from '../ui/PrivateMedia';
import { timerSeconds } from '../../lib/disappearing';

function GroupStorefront({ items, pinnedId, canList, onBuy, onList, pendingLists = [], now = 0, onRetrySecure }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null);
  const [addingPhoto, setAddingPhoto] = useState(false);
  const [formError, setFormError] = useState('');
  // A menu photo leaves the device the way a chat photo does: encrypted to a
  // host this device names, its key riding the listing payload itself. A
  // host that refuses is the shared toast's sentence — the photo is simply
  // not attached, and the listing can still post without it.
  const pickPhoto = async (event) => {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    if (!file) return;
    setAddingPhoto(true);
    try {
      setPhoto(await uploadAttachment(file, blossomServers()));
    } catch (error) {
      console.error('[shop] Encrypted photo upload failed:', error);
      useChatStore.getState().setToast({ type: 'error', message: photoRefusalToast(error?.message) });
    } finally {
      setAddingPhoto(false);
    }
  };
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
      className={`flex w-full items-center gap-3 border-b border-ink/5 p-4 text-left last:border-0 active:bg-ink/5 ${featuredCard ? 'bg-ink/[0.06]' : ''}`}
    >
      <ProductImage value={item.product.image} className="h-12 w-12 object-cover" fallback={<span className="flex h-12 w-12 items-center justify-center bg-ink/5 text-[11px] text-ink/30">Item</span>} />
      <span className="min-w-0 flex-1">
        {featuredCard && <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-accentText">Pinned</span>}
        <span className="block truncate text-[15px] font-semibold text-ink">{item.product.title || item.product.name || 'Item'}</span>
        <span className="block text-[13px] font-bold text-accentText">{money(item.product)}</span>
      </span>
    </button>
  );
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      {featured && card(featured, true)}
      {rest.map((item) => card(item, false))}
      {items.length === 0 && pendingLists.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-ink/40">No listings yet.</p>}
      </div>
      {pendingLists.map((item) => {
        const stuck = securingPhase(item.since, now) === 'stuck';
        const name = item.payload?.title || item.payload?.name || 'Listing';
        return (
          <div key={item.id} className="rounded-2xl border border-line bg-panel px-4 py-3">
            <p className="text-[15px] font-semibold text-ink">{name}</p>
            {stuck ? (
              <button type="button" onClick={() => onRetrySecure?.()} className="mt-1 block min-h-[44px] text-left text-[15px] font-semibold text-accentText underline active:scale-95">
                Still securing — retry
              </button>
            ) : (
              <p className="mt-1 text-[13px] text-ink/40">Securing…</p>
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
          onList({ title: title.trim(), priceUsd: amount, description: note.trim(), currency: 'USD', image: photo || undefined });
          setTitle(''); setPrice(''); setNote(''); setPhoto(null); setOpen(false);
        }} className="overflow-hidden rounded-2xl border border-line bg-panel">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Item" className="w-full border-b border-ink/5 bg-transparent px-4 py-3 text-[15px] text-ink outline-none placeholder:text-ink/30" />
          <input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Price in USD" inputMode="decimal" className="w-full border-b border-ink/5 bg-transparent px-4 py-3 text-[15px] text-ink outline-none placeholder:text-ink/30" />
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note" className="w-full border-b border-ink/5 bg-transparent px-4 py-3 text-[15px] text-ink outline-none placeholder:text-ink/30" />
          <div className="flex w-full items-center border-b border-ink/5">
            <label className="min-w-0 flex-1 cursor-pointer px-4 py-3">
              <span className={`block truncate text-[15px] ${photo ? 'text-ink' : 'text-ink/30'}`}>
                {addingPhoto ? 'Adding the photo…' : photo ? 'Photo added' : 'Add a photo'}
              </span>
              <input type="file" accept="image/*" className="hidden" onChange={pickPhoto} disabled={addingPhoto} />
            </label>
            {photo && !addingPhoto && (
              <button type="button" onClick={() => setPhoto(null)} className="shrink-0 px-4 py-3 text-[13px] font-semibold text-ink/45">Remove</button>
            )}
          </div>
          <button type="submit" disabled={addingPhoto} className="w-full bg-accent py-3.5 font-bold text-accentInk">Post to menu</button>
          {formError && <p role="alert" className="px-4 py-3 text-[13px] text-danger">{formError}</p>}
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

export default function GroupView({
  identity,
  sendMessage,
  sendDM,
  handleMessageAction,
  handleImageUpload,
  startRecording,
  stopRecording,
  cancelRecording,
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
  const {
    selectMode, selectedIds, isSelected, toggleSelect, cancelSelect,
    deleteSelected, forwardOpen, closeForward, openForward, forwardTo,
    wrapAction, msgKey,
  } = useThreadActions({ handleMessageAction, sendDM });
  const selectedMessages = () => new Map(
    (messages || []).flatMap((m) => (msgKey(m) ? [[msgKey(m), m]] : []))
  );
  const pinnedMessageId = useChatStore((state) => state.pinnedMessages[state.activeGroup?.id]);
  const showGroupInfo = useChatStore((state) => state.showGroupInfo);
  const setShowGroupInfo = useChatStore((state) => state.setShowGroupInfo);
  const replyingTo = useChatStore((state) => state.replyingTo);
  const setReplyingTo = useChatStore((state) => state.setReplyingTo);
  const [pane, setPane] = useState('chat');
  const isVendor = useChatStore((state) => state.isVendor);
  const setToast = useChatStore((state) => state.setToast);
  const [pendingLists, setPendingLists] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  // md+ docks the group's information pane beside the thread, the way the
  // stack already splits list and thread; below md it rides a Sheet.
  const [infoDocked, setInfoDocked] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const onChange = (event) => setInfoDocked(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

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
      if (current?.id === profile.id) {
        const merged = mergeGroupProfile(current, profile);
        if (merged.changed) useChatStore.getState().setActiveGroup(merged.next);
      }
      useChatStore.getState().setGroups((groups) => {
        const list = Array.isArray(groups) ? groups : [];
        const existing = list.find((group) => group.id === profile.id);
        if (!existing) return list;
        const merged = mergeGroupProfile(existing, profile);
        if (!merged.changed) return list;
        return list.map((group) => (group.id === profile.id ? merged.next : group));
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

  // The same contract as the composer's sendMessage (src/features/chat/
  // useComposer.js): it takes text and an optional payload, and it answers
  // with an outcome word. It used to answer with the raw result object and to
  // ignore the payload, so a document sent from a group view posted an empty
  // text message and no outcome ever matched 'sent'.
  const sendGroupText = async (text, customPayload = null) => {
    const groupId = activeGroup?.id;
    if (!groupId) return 'failed';
    const replyId = replyingTo?.id || null;
    const payload = customPayload || { type: 'text', message: text };
    const seconds = timerSeconds(useChatStore.getState().disappearingTimers?.[groupId]);
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
        return 'securing';
      }
      useChatStore.getState().setGroupMessages((prev) => ({
        ...prev,
        [groupId]: (prev[groupId] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
      }));
      try { await db.messages.delete(tempId); } catch (error) { console.error('[GroupView] Failed to remove unsent message:', error); }
      useChatStore.getState().setToast({ type: 'error', message: 'Failed to send to group' });
      return 'failed';
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
    return sendOutcome(result);
  };

  const visibleMessages = messages.filter((message) => !(deletedMsgs instanceof Set && deletedMsgs.has(message.id)));
  const shopItems = visibleMessages
    .map((message) => ({ message, product: readPayload(message) }))
    .filter(({ product }) => product?.type === 'product' && !product.soldOut);
  const canList = isVendor || activeGroup?.creator === identity?.pk;
  // A menu item rides the same send contract the composer has held since
  // cca2d53. This used to call the hook with no client id: on NO_KEY nothing
  // was queued (queueSecuringSend arms only through the client id) while the
  // toast promised the item would send when the key arrived, there was no
  // optimistic row, and a relay refusal answered { success: true, queued:
  // true, relayCount: 0 }, which the only check read as silence — a toast or
  // silence, never an item.
  const postListing = async (product) => {
    const groupId = activeGroup?.id;
    if (!groupId) return;
    const payload = { type: 'product', ...product };
    const tempId = `temp-${Date.now()}`;
    const optimistic = stampArrival({
      id: tempId,
      clientId: tempId,
      isSender: true,
      pubkey: identity?.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      replyTo: null,
      deliveryStatus: 'sending',
      rawContent: JSON.stringify(payload),
      isGroup: true,
    });
    useChatStore.getState().setGroupMessages((prev) => ({
      ...prev,
      [groupId]: [...(prev[groupId] || []), optimistic],
    }));
    await saveMessage(groupId, optimistic);
    const result = await sendGroupMessage(groupId, payload, tempId, null);
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
        return;
      }
      useChatStore.getState().setGroupMessages((prev) => ({
        ...prev,
        [groupId]: (prev[groupId] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
      }));
      try { await db.messages.delete(tempId); } catch (error) { console.error('[GroupView] Failed to remove unsent message:', error); }
      setToast({ type: 'error', message: 'Failed to send to group' });
      return;
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
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent md:flex-row">
      <div className={`flex min-h-0 flex-1 flex-col ${infoDocked ? 'min-w-0' : 'mx-auto w-full max-w-3xl'}`}>
      <ChatHeader mode="group" />
      <div className="grid grid-cols-2 border-b border-ink/5 px-4">
        {[['chat', 'Chat'], ['shop', 'Menu']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setPane(id)} className={`py-2.5 text-[13px] font-semibold ${pane === id ? 'border-b-2 border-accent text-ink' : 'text-ink/40'}`}>{label}</button>
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
      {selectMode && (
        <SelectBar
          count={selectedIds.length}
          onForward={() => { const map = selectedMessages(); openForward(null, selectedIds.map((id) => map.get(id)).filter(Boolean)); }}
          onDelete={() => deleteSelected(selectedMessages())}
          onCancel={cancelSelect}
        />
      )}
      <ThreadScroll
        messages={visibleMessages}
        emptyState={(
          <div className="m-auto mx-4 max-w-sm rounded-2xl border border-line bg-panel px-4 py-8 text-center">
            <p className="text-[15px] font-semibold text-ink">You're in {activeGroup?.name || 'this group'}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/40">Say hello. Messages stay in this chat, with a name and a time on every one.</p>
          </div>
        )}
        renderMessage={(message, { runStart, runEnd }) => {
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
              runStart={runStart}
              runEnd={runEnd}
              selectMode={selectMode}
              selected={isSelected(message)}
              onToggleSelect={toggleSelect}
              onAction={wrapAction}
            />
          );
        }}
      />
      {replyingTo && (
        <div className="mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
          <span aria-hidden="true" className="w-[2px] shrink-0 self-stretch rounded-full bg-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-accentText">{replyingTo.isSender ? 'You' : 'Replying'}</p>
            <p className="truncate text-[13px] text-inkMuted">{replyingTo.data?.message || replyingTo.rawContent || 'Message unavailable'}</p>
          </div>
          <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="touch-target flex items-center justify-center text-ink/45 hover:text-ink"><X size={18} /></button>
        </div>
      )}
      <div className="pb-safe">
        <MessageInput sendMessage={sendGroupText || sendMessage} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} cancelRecording={cancelRecording} />
      </div>
      <ForwardPicker open={forwardOpen} onClose={closeForward} onPick={forwardTo} selectedCount={selectedIds.length} />
      </>
      )}
      </div>
      <GroupInfoSidebar
        isOpen={showGroupInfo}
        onClose={() => setShowGroupInfo(false)}
        docked={infoDocked}
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
