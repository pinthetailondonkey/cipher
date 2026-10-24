import React, { useState } from 'react';
import { MessageSquare, Radio, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

export default function CreateGroupModal({ isOpen, onClose, createGroup }) {
  const name = useChatStore((state) => state.newGroupName);
  const about = useChatStore((state) => state.newGroupAbout);
  const isChannel = useChatStore((state) => state.isChannel);
  const setName = useChatStore((state) => state.setNewGroupName);
  const setAbout = useChatStore((state) => state.setNewGroupAbout);
  const setIsChannel = useChatStore((state) => state.setIsChannel);
  const [creating, setCreating] = useState(false);

  if (!isOpen) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await createGroup(event);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-group-title" className="max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] w-full max-w-md overflow-y-auto rounded-t-3xl border border-white/10 bg-[#0A0A0A] p-5 pb-safe shadow-2xl sm:rounded-3xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="create-group-title" className="text-xl font-bold text-white">Create a space</h2>
            <p className="mt-1 text-sm text-white/45">Start a group conversation or broadcast channel.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close"><X size={20} /></button>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-[#111] p-1">
          <button type="button" aria-pressed={!isChannel} onClick={() => setIsChannel(false)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors ${!isChannel ? 'bg-blue-600 text-white' : 'text-white/50 hover:text-white'}`}><MessageSquare size={16} /> Group</button>
          <button type="button" aria-pressed={isChannel} onClick={() => setIsChannel(true)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors ${isChannel ? 'bg-blue-600 text-white' : 'text-white/50 hover:text-white'}`}><Radio size={16} /> Channel</button>
        </div>
        <label className="mb-4 block text-sm font-medium text-white/70">
          {isChannel ? 'Channel name' : 'Group name'}
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder={isChannel ? 'e.g. Announcements' : 'e.g. Weekend plans'} className="mt-2 w-full rounded-xl border border-white/10 bg-[#111] px-4 py-3 text-base text-white placeholder:text-white/30 outline-none focus:border-blue-500/60" />
        </label>
        <label className="block text-sm font-medium text-white/70">
          About <span className="font-normal text-white/35">(optional)</span>
          <textarea value={about} onChange={(event) => setAbout(event.target.value)} maxLength={500} rows={3} placeholder="What is this space for?" className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-[#111] px-4 py-3 text-base text-white placeholder:text-white/30 outline-none focus:border-blue-500/60" />
        </label>
        <button type="submit" disabled={!name.trim() || creating} className="mt-5 min-h-12 w-full rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
          {creating ? 'Creating…' : `Create ${isChannel ? 'channel' : 'group'}`}
        </button>
      </form>
    </div>
  );
}
