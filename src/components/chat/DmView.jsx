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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, activeDm]);

  const visibleMessages = messages.filter((message) => !(deletedMsgs instanceof Set && deletedMsgs.has(message.id)));

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ChatHeader mode="dm" />
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
        {visibleMessages.length === 0 ? (
          <p className="m-auto mx-4 rounded-2xl border border-line bg-panel px-4 py-8 text-center text-[13px] text-ink/40">Your messages stay private between you and this person.</p>
        ) : visibleMessages.map((message, index) => {
          const peer = profiles[message.pubkey];
          // A run is a stretch of consecutive bubbles from one author: the
          // squared corner and the spacing split on the run's edges, not on
          // each message.
          const runStart = index === 0 || visibleMessages[index - 1].isSender !== message.isSender;
          const runEnd = index === visibleMessages.length - 1 || visibleMessages[index + 1].isSender !== message.isSender;
          return (
            <MessageBubble
              key={message.id}
              message={message}
              data={message.data}
              senderName={!message.isSender ? (peer?.displayName || peer?.name) : null}
              showAvatar={!message.isSender}
              avatarUrl={peer?.picture}
              avatarInitial={peer?.displayName?.charAt(0) || '?'}
              runStart={runStart}
              runEnd={runEnd}
              onAction={handleMessageAction}
            />
          );
        })}
      </div>
      {replyingTo && (
        <div className="mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
          <div className="min-w-0 flex-1 border-l-2 border-accent pl-3">
            <p className="text-[11px] font-semibold text-accentText">{replyingTo.isSender ? 'You' : 'Replying'}</p>
            <p className="truncate text-[13px] text-ink/60">{replyingTo.data?.message || replyingTo.rawContent || 'Message'}</p>
          </div>
          <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="p-2 text-ink/45 hover:text-ink"><X size={18} /></button>
        </div>
      )}
      <div className="pb-safe">
        <MessageInput sendMessage={sendMessage} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} />
      </div>
      </div>
    </section>
  );
}
