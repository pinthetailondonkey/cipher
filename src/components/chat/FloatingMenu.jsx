import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Users, MessageSquare, Radio, Flame } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { pressable } from '../ui/Button';

export default function FloatingMenu() {
  const showMenu = useChatStore((s) => s.showMenu);
  const setShowMenu = useChatStore((s) => s.setShowMenu);
  const setView = useChatStore((s) => s.setView);
  const setShowCreateGroup = useChatStore((s) => s.setShowCreateGroup);
  const setIsChannel = useChatStore((s) => s.setIsChannel);
  const setShowDeadDrop = useChatStore((s) => s.setShowDeadDrop);

  return (
    <>
      <AnimatePresence>
        {showMenu && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-fab bg-scrim/60"
              onClick={() => setShowMenu(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="fixed right-6 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-fab flex flex-col gap-3 items-end md:absolute md:right-4 md:bottom-24"
            >
              <button 
                onClick={() => { setShowMenu(false); setView('search'); }} 
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel px-5 py-3.5 font-bold text-ink shadow-lg active:bg-ink/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">New Chat</span>
                <div className="p-2 bg-accent rounded-full text-accentInk"><MessageSquare size={16} /></div>
              </button>
              
              <button 
                onClick={() => { setShowMenu(false); setShowCreateGroup(true); }} 
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-5 py-3.5 font-bold text-ink shadow-lg active:bg-ink/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">New Group</span>
                <div className="p-2 bg-accent rounded-full text-accentInk"><Users size={16} /></div>
              </button>

              <button
                onClick={() => { setShowMenu(false); setIsChannel(true); setShowCreateGroup(true); }}
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-5 py-3.5 font-bold text-ink shadow-lg active:bg-ink/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">New Channel</span>
                <div className="p-2 bg-accent rounded-full text-accentInk"><Radio size={16} /></div>
              </button>

              <button
                onClick={() => { setShowMenu(false); setShowDeadDrop(true); }}
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-5 py-3.5 font-bold text-ink shadow-lg active:bg-ink/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">Burn Note</span>
                <div className="p-2 bg-accent rounded-full text-accentInk"><Flame size={16} /></div>
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <motion.button
        animate={{ rotate: showMenu ? 45 : 0 }}
        onClick={() => setShowMenu(!showMenu)}
        aria-label={showMenu ? 'Close actions menu' : 'Open actions menu'}
        className={`fixed right-6 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-fab rounded-full bg-accent p-4 text-accentInk shadow-lg active:bg-accent md:absolute md:right-4 md:bottom-6 ${pressable}`}
      >
        <Plus size={24} strokeWidth={2.5} />
      </motion.button>
    </>
  );
}
