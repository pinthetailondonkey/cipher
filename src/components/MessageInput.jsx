import React, { useRef } from 'react';
import { Mic, Plus, SendHorizontal, Square } from 'lucide-react';
import { useChatStore } from '../store/chatStore';

export default function MessageInput({ sendMessage, handleImageUpload, startRecording, stopRecording }) {
  const input = useChatStore((state) => state.newMessage);
  const setInput = useChatStore((state) => state.setNewMessage);
  const uploading = useChatStore((state) => state.uploadingImage);
  const recording = useChatStore((state) => state.isRecording);
  const setToast = useChatStore((state) => state.setToast);
  const fileInput = useRef(null);

  const submit = async (event) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || uploading) return;
    setInput('');
    try {
      await sendMessage?.(text);
    } catch (error) {
      setInput(text);
      console.error('[MessageInput] Could not send message:', error);
      setToast({ type: 'error', message: 'Could not send message. Your draft was restored.' });
    }
  };

  // Composer: one full-radius pill, panel-strong fill, 1px line border —
  // plus on the left inside the pill, accent send on the right outside it.
  // Anchor image, skeleton B.
  return (
    <form onSubmit={submit} className="flex items-center gap-2 bg-transparent px-3 pb-2 pt-2">
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          handleImageUpload?.(event);
          event.target.value = '';
        }}
      />
      <div className="flex min-h-[44px] flex-1 items-center gap-1 rounded-full border border-line bg-panelStrong py-1 pl-1 pr-4">
        <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label="Attach images" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink/55 hover:text-ink disabled:opacity-40">
          <Plus size={20} />
        </button>
        <textarea
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
          }}
          placeholder={uploading ? 'Uploading…' : 'Message'}
          aria-label="Message"
          className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-ink outline-none placeholder:text-inkSubtle"
        />
        {recording || input.trim() ? null : (
          <button type="button" onClick={startRecording} disabled={uploading} aria-label="Record voice message" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink/55 hover:text-ink disabled:opacity-40">
            <Mic size={18} />
          </button>
        )}
      </div>
      {recording ? (
        <button type="button" onClick={stopRecording} aria-label="Stop recording" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-danger text-accentInk">
          <Square size={16} />
        </button>
      ) : (
        <button type="submit" disabled={uploading} aria-label="Send message" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accentInk disabled:opacity-40">
          <SendHorizontal size={20} />
        </button>
      )}
    </form>
  );
}
