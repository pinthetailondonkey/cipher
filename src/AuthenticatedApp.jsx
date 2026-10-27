import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { MessageSquare, Compass, Menu, User } from 'lucide-react';
import TutorialModal from './components/TutorialModal';
import Drawer from './components/chat/Drawer';
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
  const showDrawer = useChatStore((state) => state.showDrawer);
  // The drawer deep-links into Wallet views (Orders, Connections); the nonce
  // remounts Wallet when one is tapped while it is already mounted.
  const [profileStartView, setProfileStartView] = useState('main');
  const [profileNavNonce, setProfileNavNonce] = useState(0);
  const openDrawerSection = useCallback((tab, mode = null, startView = 'main') => {
    useChatStore.getState().setShowDrawer(false);
    if (mode) setExploreMode(mode);
    if (tab === 'profile') {
      setProfileStartView(startView);
      setProfileNavNonce((n) => n + 1);
    }
    setActiveTab(tab);
  }, []);
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
  const tabFallback = <div className="flex h-full items-center justify-center bg-scrim"><div className="h-7 w-7 animate-spin rounded-full border-2 border-ink/20 border-t-blue-500" /></div>;

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
    <div className="relative flex h-[100dvh] w-full justify-center overflow-hidden bg-base text-ink md:justify-start">
      {/* The shell glow is drawn once by App.jsx; screens add no own copies
          — a 120px live blur re-rasterizes per frame and stung Safari. */}
      <TutorialModal isOpen={showTutorial} onClose={() => { useChatStore.getState().setShowTutorial(false); localStorage.removeItem('cipher_new_account'); }} />
      <DeadDropModal identity={identity} />
      {/* GlobalDialog renders after CallOverlay so the flat sheet tiers keep
          the app-wide confirm above the call surface, as the old literal
          z-range did. */}
      <CallOverlay />
      <GlobalDialog />

      <main className="relative h-[100dvh] w-full max-w-md overflow-hidden md:w-auto md:max-w-none md:flex-1">
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
                  <div className="relative flex items-center px-4 pb-1 pt-3">
                    <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-ink/50 hover:text-ink md:hidden"><Menu size={20} /></button>
                    <div className="grid flex-1 grid-cols-2 rounded-2xl border border-ink/15 bg-panelStrong p-1 shadow-lg">
                      <button type="button" onClick={() => setExploreMode('shop')} className={`min-h-[44px] rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'shop' ? 'bg-accent text-accentInk shadow-lg' : 'text-ink/60'}`}>Shop</button>
                      <button type="button" onClick={() => setExploreMode('groups')} className={`min-h-[44px] rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'groups' ? 'bg-accent text-accentInk shadow-lg' : 'text-ink/60'}`}>Groups</button>
                    </div>
                  </div>
                  <div className="relative min-h-0 flex-1">
                    {exploreMode === 'shop'
                      ? <Shop identity={identity} setActiveTab={setActiveTab} />
                      : <Discover identity={identity} onJoined={() => setActiveTab('chat')} />}
                  </div>
                </div>
              )}
              {activeTab === 'profile' && (
                <div className="mx-auto h-full w-full max-w-md md:border-x md:border-line">
                  <Wallet key={profileNavNonce} identity={identity} onOpenChat={openChatFromProfile} startView={profileStartView} />
                </div>
              )}
            </Suspense>
          </div>
        )}
      </main>

      <Drawer identity={identity} open={showDrawer} onClose={() => useChatStore.getState().setShowDrawer(false)} onNavigate={openDrawerSection} />

      <nav aria-label="Tabs" className="fixed bottom-0 left-0 top-0 z-fab hidden w-[72px] flex-col items-center gap-3 border-r border-line bg-panelStrong pt-4 md:flex">
        <button onClick={() => setActiveTab('chat')} className={`relative flex w-16 flex-col items-center gap-1 rounded-2xl p-2 min-h-[52px] ${activeTab === 'chat' ? 'text-accent' : 'text-ink/40 hover:text-ink/60'}`}>
          <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
          {unreadTotal > 0 && <span className="absolute right-2 top-0 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
          <span className="text-[10px] font-medium">Chats</span>
        </button>
        <button onClick={() => setActiveTab('explore')} className={`flex w-16 flex-col items-center gap-1 rounded-2xl p-2 min-h-[52px] ${activeTab === 'explore' ? 'text-accent' : 'text-ink/40 hover:text-ink/60'}`}>
          <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
          <span className="text-[10px] font-medium">Shop</span>
        </button>
        <button onClick={() => setActiveTab('profile')} className={`relative flex w-16 flex-col items-center gap-1 rounded-2xl p-2 min-h-[52px] ${activeTab === 'profile' ? 'text-accent' : 'text-ink/40 hover:text-ink/60'}`}>
          <User size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      </nav>
    </div>
  );
}
