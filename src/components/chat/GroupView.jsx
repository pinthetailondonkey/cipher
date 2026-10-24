import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import GroupInfoSidebar from './GroupInfoSidebar';
import { useChatStore } from '../../store/chatStore';
import { db, saveMessage } from '../../db';
import { scopedRemove } from '../../lib/storage';
import { useNIP29Group, loadGroupProfile } from '../../hooks/useNIP29Group';

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
      useChatStore.getState().setGroups((groups) => (groups || []).map((group) => (
        group.id === profile.id ? { ...group, ...profile } : group
      )));
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

  const visibleMessages = messages.filter((message) => !deletedMsgs.has(message.id));
  const pinnedMessage = visibleMessages.find((message) => message.id === pinnedMessageId);
  const pinnedProduct = pinnedMessage ? readPayload(pinnedMessage) : null;

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-black">
      <ChatHeader mode="group" />
      {pinnedMessage && pinnedProduct?.type === 'product' && (
        <button
          type="button"
          onClick={() => document.getElementById(`msg-${pinnedMessage.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          className="flex items-center gap-3 border-b border-amber-300/15 bg-amber-300/[0.07] px-4 py-3 text-left"
        >
          {pinnedProduct.image && <img src={pinnedProduct.image} alt="" loading="lazy" className="h-11 w-11 rounded-lg object-cover" />}
          <span className="min-w-0 flex-1">
            <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><span aria-hidden="true">★</span> Endorsed / Pinned Listing</span>
            <span className="block truncate text-sm font-semibold text-white">{pinnedProduct.title || pinnedProduct.name || 'Product'}</span>
          </span>
        </button>
      )}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-3">
        {visibleMessages.length === 0 ? (
          <p className="m-auto px-6 text-center text-[13px] text-white/40">Messages in this group will appear here.</p>
        ) : visibleMessages.map((message) => {
          const data = message.pending ? null : readPayload(message);
          const senderProfile = profiles[message.pubkey];
          return (
            <MessageBubble
              key={message.id}
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
