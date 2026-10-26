import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { MessageSquare, Compass, User } from 'lucide-react';
import { motion } from 'framer-motion';
import TutorialModal from './components/TutorialModal';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import DeadDropModal from './components/chat/DeadDropModal';
import { requestNotificationPermission } from './lib/notifications';
import { unreadTotalOf, useChatStore } from './store/chatStore';

const Shop = lazy(() => import('./Shop'));
const Discover = lazy(() => import('./Discover'));
const Chat = lazy(() => import('./Chat'));
const Wallet = lazy(() => import('./Wallet'));

export default function AuthenticatedApp({ identity }) {
  const [activeTab, setActiveTab] = useState('chat');
  const unreadTotal = useChatStore(unreadTotalOf);
  const [exploreMode, setExploreMode] = useState('shop');
  const openChatFromProfile = useCallback((pubkey) => {
    useChatStore.getState().openChat('dm', pubkey);
    setActiveTab('chat');
  }, []);
  const showTutorial = useChatStore((state) => state.showTutorial);
  useEffect(() => {
    // New accounts get the walkthrough once; Profile opens it any time after.
    if (identity?.pk && localStorage.getItem('cipher_new_account') === 'true') {
      useChatStore.getState().setShowTutorial(true);
    }
  }, [identity?.pk]);
  const tabFallback = <div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>;

  React.useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Leaving the chat tab closes the full-screen chat overlays so a rail
  // switch never strands the user behind a fixed scrim.
  React.useEffect(() => {
    if (activeTab === 'chat') return;
    const chat = useChatStore.getState();
    chat.setShowNotifCenter(false);
    chat.setShowBookmarks(false);
    chat.setShowQRScanner(false);
  }, [activeTab]);

  return (
    <div className="relative flex h-[100dvh] w-full justify-center overflow-hidden bg-base text-white md:justify-start">
      {/* The shell glow is drawn once by App.jsx; screens add no own copies
          — a 120px live blur re-rasterizes per frame and stung Safari. */}
      <TutorialModal isOpen={showTutorial} onClose={() => { useChatStore.getState().setShowTutorial(false); localStorage.removeItem('cipher_new_account'); }} />
      <DeadDropModal identity={identity} />
      <GlobalDialog />
      <CallOverlay />

      <main className="relative z-10 h-[calc(100dvh-6.5rem-env(safe-area-inset-bottom))] w-full max-w-md overflow-hidden md:h-[100dvh] md:w-auto md:max-w-none md:flex-1">
        <div className={`absolute inset-0 md:left-[72px] ${activeTab === 'chat' ? '' : 'invisible pointer-events-none'}`}>
          <Suspense fallback={tabFallback}>
            <Chat identity={identity} />
          </Suspense>
        </div>
        {activeTab !== 'chat' && (
          <div className="absolute inset-0 md:left-[72px]">
            <Suspense fallback={tabFallback}>
              {activeTab === 'explore' && (
                <div className="relative mx-auto flex h-full w-full max-w-md flex-col md:border-x md:border-line">
                  <div className="relative z-10 px-4 pb-1 pt-3">
                    <div className="grid grid-cols-2 rounded-2xl border border-white/15 bg-panelStrong p-1 shadow-lg">
                      <button type="button" onClick={() => setExploreMode('shop')} className={`min-h-[44px] rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'shop' ? 'bg-accent text-accentInk shadow-lg' : 'text-white/60'}`}>Shop</button>
                      <button type="button" onClick={() => setExploreMode('groups')} className={`min-h-[44px] rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'groups' ? 'bg-accent text-accentInk shadow-lg' : 'text-white/60'}`}>Groups</button>
                    </div>
                  </div>
                  <div className="relative z-10 min-h-0 flex-1">
                    {exploreMode === 'shop'
                      ? <Shop identity={identity} setActiveTab={setActiveTab} />
                      : <Discover identity={identity} onJoined={() => setActiveTab('chat')} />}
                  </div>
                </div>
              )}
              {activeTab === 'profile' && (
                <div className="mx-auto h-full w-full max-w-md md:border-x md:border-line">
                  <Wallet identity={identity} onOpenChat={openChatFromProfile} />
                </div>
              )}
            </Suspense>
          </div>
        )}
      </main>

      <nav aria-label="Tabs" className="fixed bottom-0 left-0 top-0 z-20 hidden w-[72px] flex-col items-center gap-3 border-r border-line bg-panelStrong pt-4 md:flex">
        <button onClick={() => setActiveTab('chat')} className={`relative flex w-16 flex-col items-center gap-1 rounded-2xl p-2 min-h-[52px] ${activeTab === 'chat' ? 'text-accent' : 'text-white/40 hover:text-white/60'}`}>
          <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
          {unreadTotal > 0 && <span className="absolute right-2 top-0 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
          <span className="text-[10px] font-medium">Chats</span>
        </button>
        <button onClick={() => setActiveTab('explore')} className={`flex w-16 flex-col items-center gap-1 rounded-2xl p-2 min-h-[52px] ${activeTab === 'explore' ? 'text-accent' : 'text-white/40 hover:text-white/60'}`}>
          <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
          <span className="text-[10px] font-medium">Shop</span>
        </button>
        <button onClick={() => setActiveTab('profile')} className={`relative flex w-16 flex-col items-center gap-1 rounded-2xl p-2 min-h-[52px] ${activeTab === 'profile' ? 'text-accent' : 'text-white/40 hover:text-white/60'}`}>
          <User size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      </nav>

      <motion.nav
        initial={{ y: 50 }} animate={{ y: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="fixed left-4 right-4 z-20 mx-auto max-w-md rounded-3xl border border-line bg-panelStrong shadow-lg md:hidden"
        style={{ bottom: `calc(1rem + env(safe-area-inset-bottom))` }}
      >
        <div className="flex justify-around items-center min-h-[44px] max-w-md mx-auto px-6">
          <button onClick={() => setActiveTab('chat')} className={`relative flex flex-col items-center gap-1 w-16 min-h-[44px] active:scale-95 transition-transform duration-100 ${activeTab === 'chat' ? 'text-accent' : 'text-white/40'}`}>
            <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
            {unreadTotal > 0 && <span className="absolute top-1 right-3 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
            <span className="text-[10px] font-medium">Chats</span>
          </button>
          <button onClick={() => setActiveTab('explore')} className={`flex flex-col items-center gap-1 w-16 min-h-[44px] transition-all active:scale-90 ${activeTab === 'explore' ? 'text-accent' : 'text-white/40 hover:text-white/60'}`}>
            <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Shop</span>
          </button>
          <button onClick={() => setActiveTab('profile')} className={`relative flex flex-col items-center gap-1 w-16 min-h-[44px] active:scale-95 transition-transform duration-100 ${activeTab === 'profile' ? 'text-accent' : 'text-white/40'}`}>
            <User size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
            <span className="text-[10px] font-medium">Profile</span>
          </button>
        </div>
      </motion.nav>
    </div>
  );
}
