import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import { useChatStore } from '../../store/chatStore';

const EMPTY_MESSAGES = [];

export default function DmView({ sendMessage, handleMessageAction, handleImageUpload, startRecording, stopRecording }) {
  const activeDm = useChatStore((state) => state.activeDm);
  const messages = useChatStore((state) => state.dms[state.activeDm] || EMPTY_MESSAGES);
  const profiles = useChatStore((state) => state.profiles);
  const deletedMsgs = useChatStore((state) => state.deletedMsgs);
  const replyingTo = useChatStore((state) => state.replyingTo);
  const setReplyingTo = useChatStore((state) => state.setReplyingTo);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, activeDm]);

  const visibleMessages = messages.filter((message) => !deletedMsgs.has(message.id));

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-black">
      <ChatHeader mode="dm" />
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-3">
        {visibleMessages.length === 0 ? (
          <p className="m-auto px-6 text-center text-[13px] text-white/40">Your messages are private between you and this person.</p>
        ) : visibleMessages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            data={message.data}
            senderName={!message.isSender ? (profiles[message.pubkey]?.displayName || profiles[message.pubkey]?.name) : null}
            onAction={handleMessageAction}
          />
        ))}
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
    </section>
  );
}
