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
                  <div className="flex gap-2 px-4 pt-3">
                    <button type="button" onClick={() => setExploreMode('shop')} className={`rounded-full px-4 py-1.5 text-[13px] font-semibold ${exploreMode === 'shop' ? 'bg-blue-600 text-white' : 'bg-[#111] text-white/50'}`}>Shop</button>
                    <button type="button" onClick={() => setExploreMode('groups')} className={`rounded-full px-4 py-1.5 text-[13px] font-semibold ${exploreMode === 'groups' ? 'bg-blue-600 text-white' : 'bg-[#111] text-white/50'}`}>Groups</button>
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
          <button onClick={() => setActiveTab('chat')} className={`flex flex-col items-center gap-1 w-16 transition-all active:scale-90 ${activeTab === 'chat' ? 'text-blue-500' : 'text-white/40 hover:text-white/60'}`}>
            <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Chats</span>
          </button>
          <button onClick={() => setActiveTab('explore')} className={`flex flex-col items-center gap-1 w-16 transition-all active:scale-90 ${activeTab === 'explore' ? 'text-blue-500' : 'text-white/40 hover:text-white/60'}`}>
            <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Discover</span>
          </button>
          <button onClick={() => setActiveTab('profile')} className={`flex flex-col items-center gap-1 w-16 transition-all active:scale-90 ${activeTab === 'profile' ? 'text-blue-500' : 'text-white/40 hover:text-white/60'}`}>
            <User size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Profile</span>
          </button>
        </div>
      </motion.nav>
    </div>
  );
}
