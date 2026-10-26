import React, { useRef } from 'react';
import { ImagePlus, Mic, Send, Square } from 'lucide-react';
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

  return (
    <form onSubmit={submit} className="flex items-end gap-2 bg-transparent px-3 py-3">
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
      <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label="Attach images" className="shrink-0 p-2 text-ink/55 hover:text-ink disabled:opacity-40">
        <ImagePlus size={20} />
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
        className="max-h-32 min-h-10 flex-1 resize-y rounded-2xl border border-line bg-panel shadow-lg px-4 py-2.5 text-[15px] text-ink outline-none placeholder:text-ink/35 focus:border-accentSoft"
      />
      {recording ? (
        <button type="button" onClick={stopRecording} aria-label="Stop recording" className="shrink-0 rounded-full bg-red-600 p-2.5 text-ink hover:bg-red-500">
          <Square size={18} />
        </button>
      ) : input.trim() ? (
        <button type="submit" disabled={uploading} aria-label="Send message" className="shrink-0 rounded-full bg-accent p-2.5 text-accentInk hover:bg-accent disabled:opacity-40">
          <Send size={18} />
        </button>
      ) : (
        <button type="button" onClick={startRecording} disabled={uploading} aria-label="Record voice message" className="shrink-0 p-2.5 text-ink/55 hover:text-ink disabled:opacity-40">
          <Mic size={20} />
        </button>
      )}
    </form>
  );
}
