import React from 'react';
import { ArrowLeft, Info, Phone, Video, MoreVertical } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

export default function ChatHeader({ mode }) {
  const { setView, activeDm, activeGroup, profiles, setProfilePubkey, setShowGroupInfo, setToast } = useChatStore();
  
  const title = mode === 'dm' 
    ? (profiles[activeDm]?.displayName || activeDm?.slice(0, 8) || 'Chat')
    : activeGroup?.name || 'Group';
    
  const subtitle = mode === 'dm' ? 'Encrypted' : `${activeGroup?.id?.slice(0,6)}...`;

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#0a0a0a]/90 backdrop-blur-xl sticky top-0 z-40">
      <div className="flex items-center gap-3">
        <button onClick={() => setView('list')} className="p-2 -ml-2 text-white/70 hover:text-white transition-colors">
          <ArrowLeft size={22} />
        </button>
        <div 
          className="flex flex-col cursor-pointer"
          onClick={() => mode === 'dm' && setProfilePubkey(activeDm)}
        >
          <h2 className="text-[16px] font-bold text-white leading-tight">{title}</h2>
          <p className="text-[11px] text-blue-500 font-medium">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {mode === 'group' && <button type="button" onClick={() => setShowGroupInfo(true)} aria-label="Group information and pinned listing" className="touch-target p-2 text-white/50 hover:text-white transition-colors"><Info size={19} /></button>}
        <button type="button" onClick={() => setToast({ type: 'info', message: 'Voice calling is not available yet.' })} aria-label="Voice calling unavailable" className="touch-target p-2 text-white/35 hover:text-white/60 transition-colors"><Phone size={18} /></button>
        <button type="button" onClick={() => setToast({ type: 'info', message: 'Video calling is not available yet.' })} aria-label="Video calling unavailable" className="touch-target p-2 text-white/35 hover:text-white/60 transition-colors"><Video size={18} /></button>
        <button type="button" onClick={() => mode === 'group' ? setShowGroupInfo(true) : setProfilePubkey(activeDm)} aria-label={mode === 'group' ? 'More group details' : 'More contact details'} className="touch-target p-2 text-white/50 hover:text-white transition-colors"><MoreVertical size={20} /></button>
      </div>
    </div>
  );
}
