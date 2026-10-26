import React, { useState } from 'react';
import { MessageSquare, Radio, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Button, { pressable } from '../ui/Button';
import Input from '../ui/Input';

export default function CreateGroupModal({ isOpen, onClose, createGroup }) {
  const name = useChatStore((state) => state.newGroupName);
  const about = useChatStore((state) => state.newGroupAbout);
  const isChannel = useChatStore((state) => state.isChannel);
  const setName = useChatStore((state) => state.setNewGroupName);
  const setAbout = useChatStore((state) => state.setNewGroupAbout);
  const setIsChannel = useChatStore((state) => state.setIsChannel);
  const [creating, setCreating] = useState(false);
  const [listed, setListed] = useState(true);

  if (!isOpen) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await createGroup(event, listed);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-group-title" className="max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] w-full max-w-md overflow-y-auto rounded-t-3xl border border-line bg-panel p-5 pb-safe shadow-lg sm:rounded-3xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="create-group-title" className="text-2xl font-bold tracking-tight text-white">Create a space</h2>
            <p className="mt-1 text-[13px] text-white/40">Start a group conversation or broadcast channel.</p>
          </div>
          <button type="button" onClick={onClose} className={`rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white ${pressable}`} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-line bg-panelStrong shadow-lg p-1">
          <button type="button" aria-pressed={!isChannel} onClick={() => setIsChannel(false)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold ${pressable} ${!isChannel ? 'bg-accent text-accentInk active:bg-accent' : 'text-white/50 active:bg-white/10'}`}><MessageSquare size={16} /> Group</button>
          <button type="button" aria-pressed={isChannel} onClick={() => setIsChannel(true)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold ${pressable} ${isChannel ? 'bg-accent text-accentInk active:bg-accent' : 'text-white/50 active:bg-white/10'}`}><Radio size={16} /> Channel</button>
        </div>
        <label className="mb-4 block text-[13px] text-white/40">
          {isChannel ? 'Channel name' : 'Group name'}
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder={isChannel ? 'e.g. Announcements' : 'e.g. Weekend plans'} className="mt-2" />
        </label>
        <label className="block text-[13px] text-white/40">
          About <span className="font-normal">(optional)</span>
          <textarea value={about} onChange={(event) => setAbout(event.target.value)} maxLength={500} rows={3} placeholder="What is this space for?" className="mt-2 w-full resize-none rounded-2xl border border-line bg-panelStrong shadow-lg p-4 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-accentSoft" />
        </label>
        <label className="flex items-center justify-center gap-3 text-gray-400 text-sm mt-1 cursor-pointer hover:text-white transition-colors">
          <div className="relative flex items-center justify-center w-5 h-5">
            <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} className="peer appearance-none w-5 h-5 border border-white/20 rounded-md bg-white/5 checked:bg-accent checked:border-accent transition-colors" />
            <svg viewBox="0 0 16 16" className="absolute h-3.5 w-3.5 pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity" fill="none" stroke="white" strokeWidth="2.5"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
          </div>
          Show this {isChannel ? 'menu' : 'group'} in search
        </label>
        <Button type="submit" disabled={!name.trim() || creating} className="mt-5 w-full rounded-2xl py-3.5 font-bold">
          {creating ? 'Creating…' : `Create ${isChannel ? 'menu' : 'group'}`}
        </Button>
      </form>
    </div>
  );
}
