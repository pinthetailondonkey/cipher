import React, { useRef, useState } from 'react';
import { MessageSquare, Radio, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Button, { pressable } from '../ui/Button';
import Input from '../ui/Input';
import useDialogA11y from '../ui/dialogA11y';
import { ACCESS_PRIVATE, ACCESS_PUBLIC, PRIVATE_LEVEL_READY } from '../../lib/groupCreate';

export default function CreateGroupModal({ isOpen, onClose, createGroup }) {
  const name = useChatStore((state) => state.newGroupName);
  const about = useChatStore((state) => state.newGroupAbout);
  const isChannel = useChatStore((state) => state.isChannel);
  const setName = useChatStore((state) => state.setNewGroupName);
  const setAbout = useChatStore((state) => state.setNewGroupAbout);
  const setIsChannel = useChatStore((state) => state.setIsChannel);
  const groupAccess = useChatStore((state) => state.groupAccess);
  const setGroupAccess = useChatStore((state) => state.setGroupAccess);
  const [creating, setCreating] = useState(false);
  const panelRef = useRef(null);
  useDialogA11y(isOpen, onClose, panelRef);

  if (!isOpen) return null;

  // A menu is always findable and joinable: the level is a group choice, so on
  // the menu axis the screen does not offer one.
  const levelShown = !isChannel;
  const level = levelShown ? groupAccess : ACCESS_PUBLIC;

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await createGroup(event, level);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-sheet flex items-end justify-center bg-scrim/80 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form ref={panelRef} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-group-title" className="max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] w-full max-w-md overflow-y-auto rounded-t-3xl border border-line bg-panel p-5 pb-safe shadow-lg sm:rounded-3xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="create-group-title" className="text-2xl font-bold tracking-tight text-ink">Create a space</h2>
            <p className="mt-1 text-[13px] text-ink/40">Start a group conversation or share a menu.</p>
          </div>
          <button type="button" onClick={onClose} className={`rounded-full p-2 text-ink/50 hover:bg-ink/10 hover:text-ink ${pressable}`} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-line bg-panelStrong shadow-lg p-1">
          <button type="button" aria-pressed={!isChannel} onClick={() => setIsChannel(false)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold ${pressable} ${!isChannel ? 'bg-accent text-accentInk active:bg-accent' : 'text-ink/50 active:bg-ink/10'}`}><MessageSquare size={16} /> Group</button>
          <button type="button" aria-pressed={isChannel} onClick={() => setIsChannel(true)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold ${pressable} ${isChannel ? 'bg-accent text-accentInk active:bg-accent' : 'text-ink/50 active:bg-ink/10'}`}><Radio size={16} /> Menu</button>
        </div>
        <label className="mb-4 block text-[13px] text-ink/40">
          {isChannel ? 'Menu name' : 'Group name'}
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder={isChannel ? 'e.g. Announcements' : 'e.g. Weekend plans'} className="mt-2" />
        </label>
        <label className="block text-[13px] text-ink/40">
          About <span className="font-normal">(optional)</span>
          <textarea value={about} onChange={(event) => setAbout(event.target.value)} maxLength={500} rows={3} placeholder="What is this space for?" className="mt-2 w-full resize-none rounded-2xl border border-line bg-panelStrong shadow-lg p-4 text-[15px] text-ink placeholder-ink/30 focus:outline-none focus:border-accentSoft" />
        </label>
        {levelShown && (
          /* Who may read the group. Two levels, and the line under them says
             only what has been measured. There is no "show in search" switch:
             unticking one used to hide a public group from this app's search
             and from nothing else, because the relay still served it to anyone
             who asked for it by id. */
          <div className="mt-4">
            <p className="mb-2 text-[13px] text-ink/40">Who can read it</p>
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-line bg-panelStrong shadow-lg p-1">
              <button
                type="button"
                aria-pressed={level === ACCESS_PUBLIC}
                onClick={() => setGroupAccess(ACCESS_PUBLIC)}
                className={`flex min-h-11 items-center justify-center rounded-xl text-[15px] font-semibold ${pressable} ${level === ACCESS_PUBLIC ? 'bg-accent text-accentInk' : 'text-ink/50 active:bg-ink/10'}`}
              >
                Public
              </button>
              <button
                type="button"
                aria-pressed={level === ACCESS_PRIVATE}
                disabled={!PRIVATE_LEVEL_READY}
                onClick={() => setGroupAccess(ACCESS_PRIVATE)}
                className={`flex min-h-11 items-center justify-center rounded-xl text-[15px] font-semibold disabled:opacity-40 ${pressable} ${level === ACCESS_PRIVATE ? 'bg-accent text-accentInk' : 'text-ink/50 active:bg-ink/10'}`}
              >
                Private
              </button>
            </div>
            <p className="mt-2 text-[13px] text-inkMuted" role="note">
              {level === ACCESS_PRIVATE
                ? 'Private groups are not available yet.'
                : 'Anyone can find this group and read it.'}
            </p>
          </div>
        )}
        <Button type="submit" disabled={!name.trim() || creating} className="mt-5 w-full rounded-2xl py-3.5 font-bold">
          {creating ? 'Creating…' : `Create ${isChannel ? 'menu' : 'group'}`}
        </Button>
      </form>
    </div>
  );
}
