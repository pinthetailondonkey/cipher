import React from 'react';
import { X } from 'lucide-react';
import MessageBubble from '../MessageBubble';
import MessageInput from '../MessageInput';
import ChatHeader from './ChatHeader';
import ThreadScroll, { SelectBar } from './ThreadScroll';
import ForwardPicker from './ForwardPicker';
import { useThreadActions } from './useThreadActions';
import { useChatStore } from '../../store/chatStore';

export default function DmView({ sendMessage, handleMessageAction, handleImageUpload, startRecording, stopRecording, sendDM }) {
  const activeDm = useChatStore((state) => state.activeDm);
  const messages = useChatStore((state) => state.dms[state.activeDm] || []);
  const deletedMsgs = useChatStore((state) => state.deletedMsgs);
  const profiles = useChatStore((state) => state.profiles);
  const replyingTo = useChatStore((state) => state.replyingTo);
  const setReplyingTo = useChatStore((state) => state.setReplyingTo);

  const {
    selectMode, selectedIds, isSelected, toggleSelect, cancelSelect,
    deleteSelected, forwardOpen, closeForward, openForward, forwardTo,
    wrapAction, msgKey,
  } = useThreadActions({ handleMessageAction, sendDM });

  const visibleMessages = messages.filter((message) => !(deletedMsgs instanceof Set && deletedMsgs.has(message.id)));
  const selectedMessages = () => new Map(visibleMessages.map((m) => [msgKey(m), m]).filter(([id]) => id));

  // Payment request composer item: the order-flow start with this chat's
  // peer, through the same message-command actor the product cards use.
  const requestPayment = activeDm
    ? () => handleMessageAction('buy_product', { id: null, pubkey: activeDm, data: {} })
    : undefined;

  const renderMessage = (message, { runStart, runEnd }) => {
    const peer = profiles[message.pubkey];
    return (
      <MessageBubble
        message={message}
        data={message.data}
        senderName={!message.isSender ? (peer?.displayName || peer?.name) : null}
        showAvatar={!message.isSender}
        avatarUrl={peer?.picture}
        avatarInitial={peer?.displayName?.charAt(0) || '?'}
        runStart={runStart}
        runEnd={runEnd}
        selectMode={selectMode}
        selected={isSelected(message)}
        onToggleSelect={toggleSelect}
        onAction={wrapAction}
      />
    );
  };

  const emptyState = (
    <p className="m-auto mx-4 rounded-2xl border border-line bg-panel px-4 py-8 text-center text-[13px] text-ink/40">Your messages stay private between you and this person.</p>
  );

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ChatHeader mode="dm" />
      {selectMode && (
        <SelectBar
          count={selectedIds.length}
          onForward={() => { const map = selectedMessages(); openForward(null, selectedIds.map((id) => map.get(id)).filter(Boolean)); }}
          onDelete={() => deleteSelected(selectedMessages())}
          onCancel={cancelSelect}
        />
      )}
      <ThreadScroll messages={visibleMessages} emptyState={emptyState} renderMessage={renderMessage} />
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
        <MessageInput sendMessage={sendMessage} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} onPaymentRequest={requestPayment} />
      </div>
      </div>
      <ForwardPicker open={forwardOpen} onClose={closeForward} onPick={forwardTo} selectedCount={selectedIds.length} />
    </section>
  );
}
