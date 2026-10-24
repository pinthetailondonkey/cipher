import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import GroupInfoSidebar from './GroupInfoSidebar';
import { useChatStore } from '../../store/chatStore';

const EMPTY_MESSAGES = [];

function readPayload(message) {
  if (message.data) return message.data;
  if (!message.rawContent) return null;
  try {
    return JSON.parse(message.rawContent);
  } catch {
    return { type: 'text', message: message.rawContent };
  }
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
    if (activeGroup?.id) {
      fetchPinnedMessage(activeGroup.id).catch((error) => {
        console.error('[GroupView] Could not fetch pinned listing:', error);
      });
    }
  }, [activeGroup?.id, fetchPinnedMessage]);

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
          return (
            <MessageBubble
              key={message.id}
              message={message}
              data={data || { type: 'text', message: message.pending ? 'Waiting for group encryption key…' : 'Message unavailable' }}
              senderName={message.isSender ? null : (profiles[message.pubkey]?.displayName || profiles[message.pubkey]?.name || message.pubkey?.slice(0, 8))}
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
      <MessageInput sendMessage={sendMessage} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} />
      <GroupInfoSidebar
        isOpen={showGroupInfo}
        onClose={() => setShowGroupInfo(false)}
        identity={identity}
        fetchGroupMembers={fetchGroupMembers}
        fetchPinnedMessage={fetchPinnedMessage}
        onPin={pinMessage}
        onUnpin={unpinMessage}
      />
    </section>
  );
}
