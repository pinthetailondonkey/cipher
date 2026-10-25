import React, { lazy, Suspense, useCallback, useState } from 'react';
import { MessageSquare, Compass, User } from 'lucide-react';
import { motion } from 'framer-motion';
import TutorialModal from './components/TutorialModal';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import { requestNotificationPermission } from './lib/notifications';
import { notifTotalOf, unreadTotalOf, useChatStore } from './store/chatStore';

const Shop = lazy(() => import('./Shop'));
const Discover = lazy(() => import('./Discover'));
const Chat = lazy(() => import('./Chat'));
const Wallet = lazy(() => import('./Wallet'));

export default function AuthenticatedApp({ identity }) {
  const [activeTab, setActiveTab] = useState('chat');
  const unreadTotal = useChatStore(unreadTotalOf);
  const notifTotal = useChatStore(notifTotalOf);
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
    <div className="relative flex h-[100dvh] w-full justify-center overflow-hidden bg-black text-white">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-[-10%] top-[-10%] h-[50%] w-[50%] rounded-full bg-blue-600/20 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[50%] w-[50%] rounded-full bg-purple-600/10 blur-[120px]" />
      </div>
      <TutorialModal isOpen={showTutorial} onClose={() => { setShowTutorial(false); localStorage.removeItem('cipher_new_account'); }} />
      <GlobalDialog />
      <CallOverlay />

      <main className="relative z-10 h-[calc(100dvh-6.5rem-env(safe-area-inset-bottom))] w-full max-w-md overflow-hidden">
        <div className={`absolute inset-0 ${activeTab === 'chat' ? '' : 'invisible pointer-events-none'}`}>
          <Suspense fallback={tabFallback}>
            <Chat identity={identity} />
          </Suspense>
        </div>
        {activeTab !== 'chat' && (
          <div className="absolute inset-0">
            <Suspense fallback={tabFallback}>
              {activeTab === 'explore' && (
                <div className="relative flex h-full flex-col">
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute left-[-20%] top-[-10%] h-[55%] w-[70%] rounded-full bg-blue-500/30 blur-[100px]" />
                    <div className="absolute bottom-[-15%] right-[-20%] h-[50%] w-[70%] rounded-full bg-purple-500/25 blur-[110px]" />
                  </div>
                  <div className="relative z-10 px-4 pb-1 pt-3">
                    <div className="grid grid-cols-2 rounded-2xl border border-white/15 bg-white/10 p-1 shadow-2xl backdrop-blur-2xl">
                      <button type="button" onClick={() => setExploreMode('shop')} className={`rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'shop' ? 'bg-blue-600 text-white shadow-lg' : 'text-white/60'}`}>Shop</button>
                      <button type="button" onClick={() => setExploreMode('groups')} className={`rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'groups' ? 'bg-blue-600 text-white shadow-lg' : 'text-white/60'}`}>Groups</button>
                    </div>
                  </div>
                  <div className="relative z-10 min-h-0 flex-1">
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
        className="fixed bottom-4 left-4 right-4 z-20 mx-auto max-w-md rounded-3xl border border-white/10 bg-white/5 shadow-2xl backdrop-blur-xl"
      >
        <div className="flex justify-around items-center h-16 max-w-md mx-auto px-6">
          <button onClick={() => setActiveTab('chat')} className={`relative flex flex-col items-center gap-1 w-16 active:scale-95 transition-transform duration-100 ${activeTab === 'chat' ? 'text-blue-500' : 'text-white/40'}`}>
            <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
            {unreadTotal > 0 && <span className="absolute top-1 right-3 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
            <span className="text-[10px] font-medium">Chats</span>
          </button>
          <button onClick={() => setActiveTab('explore')} className={`flex flex-col items-center gap-1 w-16 transition-all active:scale-90 ${activeTab === 'explore' ? 'text-blue-500' : 'text-white/40 hover:text-white/60'}`}>
            <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Shop</span>
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
