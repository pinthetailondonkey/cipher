import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Users, MessageSquare, Radio } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { pressable } from '../ui/Button';

export default function FloatingMenu() {
  const showMenu = useChatStore((s) => s.showMenu);
  const setShowMenu = useChatStore((s) => s.setShowMenu);
  const setView = useChatStore((s) => s.setView);
  const setShowCreateGroup = useChatStore((s) => s.setShowCreateGroup);
  const setIsChannel = useChatStore((s) => s.setIsChannel);

  return (
    <>
      <AnimatePresence>
        {showMenu && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/60"
              onClick={() => setShowMenu(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="fixed right-6 flex flex-col gap-3 items-end z-50"
              style={{ bottom: `calc(10rem + env(safe-area-inset-bottom))` }}
            >
              <button 
                onClick={() => { setShowMenu(false); setView('search'); }} 
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-5 py-3.5 font-bold text-white shadow-lg active:bg-white/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">New Chat</span>
                <div className="p-2 bg-accent rounded-full text-accentInk shadow-lg"><MessageSquare size={16} /></div>
              </button>
              
              <button 
                onClick={() => { setShowMenu(false); setShowCreateGroup(true); }} 
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-5 py-3.5 font-bold text-white shadow-lg active:bg-white/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">New Group</span>
                <div className="p-2 bg-accent rounded-full text-accentInk shadow-lg"><Users size={16} /></div>
              </button>

              <button
                onClick={() => { setShowMenu(false); setIsChannel(true); setShowCreateGroup(true); }}
                className={`flex items-center gap-3 rounded-2xl border border-line bg-panel shadow-lg px-5 py-3.5 font-bold text-white shadow-lg active:bg-white/10 ${pressable}`}
              >
                <span className="text-sm font-bold tracking-wide">New Channel</span>
                <div className="p-2 bg-accent rounded-full text-accentInk shadow-lg"><Radio size={16} /></div>
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <motion.button
        animate={{ rotate: showMenu ? 45 : 0 }}
        onClick={() => setShowMenu(!showMenu)}
        className={`fixed right-6 z-50 rounded-full bg-accent p-4 text-accentInk shadow-[0_0_20px_rgba(37,99,235,0.4)] active:bg-accent ${pressable}`}
        style={{ bottom: `calc(6rem + env(safe-area-inset-bottom))` }}
      >
        <Plus size={24} strokeWidth={2.5} />
      </motion.button>
    </>
  );
}
