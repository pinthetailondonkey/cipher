import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { MessageSquare, Compass, Menu, User } from 'lucide-react';
import TutorialModal from './components/TutorialModal';
import Drawer from './components/chat/Drawer';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import DeadDropModal from './components/chat/DeadDropModal';
import Avatar from './components/ui/Avatar';
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
  const myProfile = useChatStore((state) => (identity?.pk ? state.profiles[identity.pk] : undefined));

  // Telegram-idiom icon rail: at md the 72px strip widens to 240px while
  // hovered or focus-within, and labels slide in beside the icons. Pure CSS
  // (group/nav variants, no state): the expanded rail overlays the panes —
  // it is z-20 over main's z-10 — so pane geometry stays keyed to 72px.
  // Buttons are ALWAYS flex-row with the icon in a fixed 40px box, so an
  // item keeps its exact position collapsed and expanded; only the label's
  // width/opacity animate. Nothing reshuffles under the cursor (the old
  // column-to-row flip moved every button and broke click targeting).
  const railButton = 'flex w-full flex-row items-center justify-start px-4';
  const railLabel = 'w-0 overflow-hidden whitespace-nowrap pl-3 text-xs font-medium opacity-0 -translate-x-2 transition-all duration-200 ease-out md:group-hover/nav:w-auto md:group-hover/nav:opacity-100 md:group-hover/nav:translate-x-0 md:group-focus-within/nav:w-auto md:group-focus-within/nav:opacity-100 md:group-focus-within/nav:translate-x-0';
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
      <GlobalDialog />
      <CallOverlay />

      <main className="relative z-10 h-[100dvh] w-full max-w-md overflow-hidden md:w-auto md:max-w-none md:flex-1">
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
                  <div className="relative z-10 flex items-center px-4 pb-1 pt-3">
                    <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-ink/50 hover:text-ink md:hidden"><Menu size={20} /></button>
                    <div className="grid flex-1 grid-cols-2 rounded-2xl border border-ink/15 bg-panelStrong p-1 shadow-lg">
                      <button type="button" onClick={() => setExploreMode('shop')} className={`min-h-[44px] rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'shop' ? 'bg-accent text-accentInk shadow-lg' : 'text-ink/60'}`}>Shop</button>
                      <button type="button" onClick={() => setExploreMode('groups')} className={`min-h-[44px] rounded-xl py-2.5 text-[13px] font-bold ${exploreMode === 'groups' ? 'bg-accent text-accentInk shadow-lg' : 'text-ink/60'}`}>Groups</button>
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
                  <Wallet key={profileNavNonce} identity={identity} onOpenChat={openChatFromProfile} startView={profileStartView} />
                </div>
              )}
            </Suspense>
          </div>
        )}
      </main>

      <Drawer identity={identity} open={showDrawer} onClose={() => useChatStore.getState().setShowDrawer(false)} onNavigate={openDrawerSection} />

      <nav aria-label="Tabs" className="group/nav fixed bottom-0 left-0 top-0 z-20 hidden w-[72px] flex-col items-stretch overflow-hidden gap-1 border-r border-line bg-panelStrong pt-4 md:flex md:transition-[width] md:duration-200 md:ease-out md:hover:w-60 md:focus-within:w-60">
        {/* Account row holds its height in both states — only the name
            slides in — so the buttons below never move. */}
        <div className="flex h-14 w-full flex-row items-center gap-3 px-4">
          <span className="flex h-8 w-8 flex-none items-center justify-center">
            <Avatar src={myProfile?.picture} name={myProfile?.displayName || identity?.name || 'C'} className="h-8 w-8" />
          </span>
          <span className={`min-w-0 flex-1 overflow-hidden ${railLabel}`}>
            <span className="block truncate font-bold text-ink">Cipher</span>
            <span className="block truncate text-[11px] text-ink/40">{myProfile?.displayName || myProfile?.name || ''}</span>
          </span>
        </div>
        <button onClick={() => setActiveTab('chat')} className={`relative h-12 flex-none ${railButton} ${activeTab === 'chat' ? 'text-accentText' : 'text-ink/40 hover:text-ink/60'}`}>
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full hover:bg-ink/5">
            <MessageSquare size={22} strokeWidth={activeTab === 'chat' ? 2.5 : 2} />
          </span>
          {unreadTotal > 0 && <span className="absolute left-[46px] top-0 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
          <span className={railLabel}>Chats</span>
        </button>
        <button onClick={() => setActiveTab('explore')} className={`relative h-12 flex-none ${railButton} ${activeTab === 'explore' ? 'text-accentText' : 'text-ink/40 hover:text-ink/60'}`}>
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full hover:bg-ink/5">
            <Compass size={22} strokeWidth={activeTab === 'explore' ? 2.5 : 2} />
          </span>
          <span className={railLabel}>Shop</span>
        </button>
        <button onClick={() => setActiveTab('profile')} className={`relative h-12 flex-none ${railButton} ${activeTab === 'profile' ? 'text-accentText' : 'text-ink/40 hover:text-ink/60'}`}>
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full hover:bg-ink/5">
            <User size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
          </span>
          <span className={railLabel}>Profile</span>
        </button>
      </nav>
    </div>
  );
}
