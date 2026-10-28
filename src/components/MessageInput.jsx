import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Camera, FileText, Image, Mic, Plus, SendHorizontal, Square, Wallet } from 'lucide-react';
import { useChatStore } from '../store/chatStore';
import Sheet from './ui/Sheet';
import IconButton from './ui/IconButton';
import { scopedGet, scopedSet } from '../lib/storage';
import { haptic } from '../lib/haptics';
import { uploadPrivateMedia } from '../lib/mediaCrypto';

// Draft restore per chat: same scoped keys the composer already clears on
// send (draft-dm-*, draft-group-*). A switch of chat swaps the draft with it;
// a reload brings the words back.
function draftKeyOf(view, activeDm, activeGroup) {
  if (view === 'group' && activeGroup?.id) return `draft-group-${activeGroup.id}`;
  if (activeDm) return `draft-dm-${activeDm}`;
  return null;
}

function clockLabel(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function MessageInput({ sendMessage, handleImageUpload, startRecording, stopRecording, onPaymentRequest }) {
  const input = useChatStore((state) => state.newMessage);
  const setInput = useChatStore((state) => state.setNewMessage);
  const uploading = useChatStore((state) => state.uploadingImage);
  const recording = useChatStore((state) => state.isRecording);
  const setToast = useChatStore((state) => state.setToast);
  const setUploadingImage = useChatStore((state) => state.setUploadingImage);
  const view = useChatStore((state) => state.view);
  const activeDm = useChatStore((state) => state.activeDm);
  const activeGroup = useChatStore((state) => state.activeGroup);
  const setShowQRScanner = useChatStore((state) => state.setShowQRScanner);
  const fileInput = useRef(null);
  const docInput = useRef(null);
  const textRef = useRef(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recLocked, setRecLocked] = useState(false);
  const draftKey = draftKeyOf(view, activeDm, activeGroup);
  const displayedKeyRef = useRef(draftKey);

  // Every keystroke saves under the chat whose text is on screen.
  useEffect(() => {
    const key = displayedKeyRef.current;
    if (key && typeof input === 'string') scopedSet(key, input);
  }, [input]);

  // A chat swap swaps the draft with it: read the new chat's draft and mark
  // this chat as the one now being displayed before the swap re-renders.
  useEffect(() => {
    if (!draftKey || draftKey === displayedKeyRef.current) return;
    const saved = scopedGet(draftKey, '');
    displayedKeyRef.current = draftKey;
    setInput(typeof saved === 'string' ? saved : '');
  }, [draftKey, setInput]);

  useEffect(() => {
    if (!recording) {
      setRecSeconds(0);
      setRecLocked(false);
      return undefined;
    }
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // Autogrow: 1 line idle, at most 5 lines before it scrolls.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
  }, [input, recording]);

  const submit = async (event) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || uploading) return;
    setInput('');
    try {
      // A send the relays refused is not the user's text thrown away: the
      // field takes it back so the next press is free.
      const outcome = await sendMessage?.(text);
      if (outcome === 'failed') setInput(text);
    } catch (error) {
      setInput(text);
      console.error('[MessageInput] Could not send message:', error);
      setToast({ type: 'error', message: 'Could not send message. Your draft was restored.' });
    }
  };

  const sendDocument = async (event) => {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    if (!file) return;
    setPlusOpen(false);
    setUploadingImage(true);
    setToast({ type: 'success', message: 'Sending the file…' });
    try {
      // The document rides the existing voice-note sender: same encrypted
      // upload, same payload shape, the file's name carried alongside.
      const entry = await uploadPrivateMedia(file);
      const outcome = await sendMessage('', { type: 'audio', ...entry, name: file.name });
      if (outcome === 'sent') setToast({ type: 'success', message: 'File sent!' });
    } catch (error) {
      console.error('[media] Encrypted file upload failed:', error);
      setToast({ type: 'error', message: 'The file was not sent. No media host took the encrypted file.' });
    } finally {
      setUploadingImage(false);
    }
  };

  // Photo gallery, camera, document, payment request: each item maps to the
  // existing sender behind it. Payment request opens the order flow with
  // this vendor — a group chat has no single vendor to open against.
  const runPlus = (key) => {
    if (key === 'photo') fileInput.current?.click();
    if (key === 'camera') setShowQRScanner(true);
    if (key === 'document') docInput.current?.click();
    if (key === 'payment') onPaymentRequest?.();
  };
  const basePlusItems = [
    { key: 'photo', icon: Image, label: 'Photo gallery' },
    { key: 'camera', icon: Camera, label: 'Camera' },
    { key: 'document', icon: FileText, label: 'Document' },
  ];
  const plusItems = (activeGroup?.id ? basePlusItems : [
    ...basePlusItems,
    { key: 'payment', icon: Wallet, label: 'Payment request' },
  ]);

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
      <input ref={docInput} type="file" className="hidden" onChange={sendDocument} />
      <div className="flex min-h-[44px] flex-1 items-center gap-1 rounded-[22px] border border-line bg-panelStrong py-1 pl-1 pr-2">
        {recording ? (
          <>
            <span aria-hidden="true" className="ml-2 flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full bg-danger ${recLocked ? '' : 'animate-pulse'}`} />
              <span className="mono text-[13px] font-semibold text-ink">{clockLabel(recSeconds)}</span>
            </span>
            <span className="flex-1" />
            {!recLocked && (
              <motion.button
                type="button"
                aria-label="Slide to lock recording"
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.2}
                onDragEnd={(_, info) => {
                  if (info.offset.x > 60) {
                    haptic('light');
                    setRecLocked(true);
                    setToast({ type: 'success', message: 'Recording locked. Tap stop when done.' });
                  }
                }}
                className="flex h-9 items-center gap-1 rounded-full bg-ink/10 px-3 text-[11px] font-semibold text-ink/60"
              >
                <Mic size={13} /> slide to lock
              </motion.button>
            )}
            {recLocked && <span className="text-[11px] font-semibold text-danger">locked</span>}
          </>
        ) : (
          <>
            <IconButton onClick={() => { setPlusOpen(true); }} label="Add attachment" className="text-ink/55 disabled:opacity-40" disabled={uploading}>
              <Plus size={20} />
            </IconButton>
            <textarea
              ref={textRef}
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
              className="max-h-[100px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-ink outline-none placeholder:text-inkSubtle"
            />
            {input.trim() ? null : (
              <IconButton onClick={startRecording} label="Record voice message" className="text-ink/55 disabled:opacity-40" disabled={uploading}>
                <Mic size={18} />
              </IconButton>
            )}
          </>
        )}
      </div>
      {recording ? (
        <button type="button" onClick={stopRecording} aria-label="Stop recording" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-danger text-accentInk">
          <Square size={16} />
        </button>
      ) : (
        <button type="submit" disabled={uploading} aria-label="Send message" className={`flex shrink-0 items-center justify-center rounded-full bg-accent text-accentInk disabled:opacity-40 ${input.trim() ? 'h-10 w-10' : 'h-11 w-11'}`}>
          <SendHorizontal size={20} />
        </button>
      )}
      <Sheet open={plusOpen} onClose={() => setPlusOpen(false)} title="Add">
        <div className="grid grid-cols-2 gap-2 px-4 pb-2 pt-1">
          {plusItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => { runPlus(item.key); setPlusOpen(false); }}
              className="flex min-h-[44px] items-center gap-2 rounded-2xl border border-line bg-panelStrong px-3 py-3 text-left text-[13px] font-semibold text-ink active:bg-ink/10"
            >
              <item.icon size={16} className="text-accentText" />
              {item.label}
            </button>
          ))}
        </div>
      </Sheet>
    </form>
  );
}
