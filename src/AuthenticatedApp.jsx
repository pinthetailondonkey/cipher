import React, { lazy, Suspense, useCallback, useState } from 'react';
import { MessageSquare, Compass, User } from 'lucide-react';
import { motion } from 'framer-motion';
import TutorialModal from './components/TutorialModal';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import { requestNotificationPermission } from './lib/notifications';
import { useChatStore } from './store/chatStore';

const Shop = lazy(() => import('./Shop'));
const Discover = lazy(() => import('./Discover'));
const Chat = lazy(() => import('./Chat'));
const Wallet = lazy(() => import('./Wallet'));

export default function AuthenticatedApp({ identity }) {
  const [activeTab, setActiveTab] = useState('chat');
  const unreadTotal = useChatStore((state) => Object.values(state.unreadCounts || {}).reduce((sum, count) => sum + (Number(count) || 0), 0));
  const notifTotal = useChatStore((state) => Object.entries(state.unreadCounts || {}).reduce((sum, [id, count]) => {
    const fresh = Math.max(0, (Number(count) || 0) - (Number(state.notifAck?.[id]) || 0));
    return sum + fresh;
  }, 0));
  const [exploreMode, setExploreMode] = useState('shop');
  const openChatFromProfile = useCallback((pubkey) => {
    useChatStore.getState().openChat('dm', pubkey);
    setActiveTab('chat');
  }, []);
  const [showTutorial, setShowTutorial] = useState(() => (
    !!identity?.pk && localStorage.getItem('cipher_new_account') === 'true'
  ));
  const tabFallback = <div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>;

  React.useEffect(() => {
    requestNotificationPermission();
  }, []);

  return (
    <div className="h-[100dvh] w-full bg-black text-white overflow-hidden flex justify-center relative">
      <div className="absolute top-0 left-0 right-0 h-64 bg-[radial-gradient(ellipse_at_top_left,_rgba(37,99,235,0.15),_transparent_60%)] pointer-events-none z-0" />
      <TutorialModal isOpen={showTutorial} onClose={() => { setShowTutorial(false); localStorage.removeItem('cipher_new_account'); }} />
      <GlobalDialog />
      <CallOverlay />

      <main className="w-full max-w-md h-[calc(100dvh-4rem-env(safe-area-inset-bottom))] relative overflow-hidden z-10">
        <div className={`absolute inset-0 ${activeTab === 'chat' ? '' : 'invisible pointer-events-none'}`}>
          <Suspense fallback={tabFallback}>
            <Chat identity={identity} />
          </Suspense>
        </div>
        {activeTab !== 'chat' && (
          <div className="absolute inset-0 bg-black">
            <Suspense fallback={tabFallback}>
              {activeTab === 'explore' && (
                <div className="flex h-full flex-col bg-black">
                  <div className="grid grid-cols-2 border-b border-white/10">
                    <button type="button" onClick={() => setExploreMode('shop')} className={`py-2.5 text-[13px] font-semibold ${exploreMode === 'shop' ? 'border-b-2 border-blue-600 text-white' : 'text-white/40'}`}>Shop</button>
                    <button type="button" onClick={() => setExploreMode('groups')} className={`py-2.5 text-[13px] font-semibold ${exploreMode === 'groups' ? 'border-b-2 border-blue-600 text-white' : 'text-white/40'}`}>Groups</button>
                  </div>
                  <div className="min-h-0 flex-1">
                    {exploreMode === 'shop'
                      ? <Shop identity={identity} setActiveTab={setActiveTab} />
                      : <Discover identity={identity} onJoined={() => setActiveTab('chat')} />}
                  </div>
                </div>
              )}
              {activeTab === 'profile' && <Wallet identity={identity} onOpenChat={openChatFromProfile} />}
            </Suspense>
          </div>
        )}
      </main>

      <motion.nav
        initial={{ y: 50 }} animate={{ y: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="fixed bottom-0 left-0 right-0 z-[5] bg-black/80 backdrop-blur-2xl border-t border-white/10 pb-safe"
      >
        <div className="flex justify-around items-center h-16 max-w-md mx-auto px-6">
          <button onClick={() => setActiveTab('chat')} className={`relative flex flex-col items-center gap-1 w-16 active:scale-95 transition-transform duration-100 ${activeTab === 'chat' ? 'text-blue-500' : 'text-white/40'}`}>
            <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
            {unreadTotal > 0 && <span className="absolute top-1 right-3 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
            <span className="text-[10px] font-medium">Chats</span>
          </button>
          <button onClick={() => setActiveTab('explore')} className={`flex flex-col items-center gap-1 w-16 transition-all active:scale-90 ${activeTab === 'explore' ? 'text-blue-500' : 'text-white/40 hover:text-white/60'}`}>
            <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Discover</span>
          </button>
          <button onClick={() => setActiveTab('profile')} className={`relative flex flex-col items-center gap-1 w-16 active:scale-95 transition-transform duration-100 ${activeTab === 'profile' ? 'text-blue-500' : 'text-white/40'}`}>
            <User size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
            {notifTotal > 0 && <span className="absolute top-1 right-3 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white">{notifTotal > 99 ? '99+' : notifTotal}</span>}
            <span className="text-[10px] font-medium">Profile</span>
          </button>
        </div>
      </motion.nav>
    </div>
  );
}
