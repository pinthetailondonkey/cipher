import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { MessageSquare, Compass, Menu, User } from 'lucide-react';
import TutorialModal from './components/TutorialModal';
import Rail from './components/ui/Rail';
import Drawer from './components/chat/Drawer';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import DeadDropModal from './components/chat/DeadDropModal';
import Toast from './components/ui/Toast';
import Segmented from './components/ui/Segmented';
import CommandPalette from './components/ui/CommandPalette';
import { requestNotificationPermission } from './lib/notifications';
import { unreadTotalOf, useChatStore } from './store/chatStore';

const Menus = lazy(() => import('./Menus'));
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
  const openChatFromPalette = useCallback((type, id, group) => {
    useChatStore.getState().openChat(type, id, group || null);
    setActiveTab('chat');
  }, []);
  // ⌘K opens the command palette at md+ (master §2): the same command key a
  // desktop keyboard expects, and no phone surface changes.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        if (window.matchMedia('(min-width: 768px)').matches) setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const showTutorial = useChatStore((state) => state.showTutorial);
  // The vendor menu lives over the chat surface (it is the chat tab's own
  // pane on wide screens), so opening one — from Discover, the chat list,
  // or the Menus browse — lands on the chat tab first, menu on top. Where
  // the drill-down came from is remembered once, so closing the menu puts
  // the user back where they were — the Menus browse, say — instead of
  // stranding them in a tab they never chose.
  const vendorMenuPubkey = useChatStore((state) => state.vendorStorefrontPubkey);
  const vendorMenuTabRef = React.useRef('');
  React.useEffect(() => {
    if (vendorMenuPubkey) {
      if (!vendorMenuTabRef.current) vendorMenuTabRef.current = activeTab;
      if (activeTab !== 'chat') setActiveTab('chat');
    } else if (vendorMenuTabRef.current) {
      if (vendorMenuTabRef.current !== 'chat') setActiveTab(vendorMenuTabRef.current);
      vendorMenuTabRef.current = '';
    }
  }, [vendorMenuPubkey, activeTab]);
  // A saved product link (?product=&vendor=) resolves on boot and opens its
  // checkout over the Menus pane (the explore tab's own shop section — the
  // value name is the engineering key; the label the user reads is Menus).
  // The checkout renders inside Menus, so this shell follows the checkout
  // product the link sets. The move rides the store subscription: a Buy tap
  // opens the checkout on a tab that already shows the menu, and closing
  // one never moves the shell.
  useEffect(() => {
    return useChatStore.subscribe((state, previous) => {
      const id = state.checkoutProduct?.id || null;
      if (id && id !== (previous?.checkoutProduct?.id || null)) {
        setExploreMode('shop');
        setActiveTab('explore');
      }
    });
  }, [setActiveTab]);
  useEffect(() => {
    // New accounts get the walkthrough once, and land on the Menus tab —
    // browsing the network's vendors is the front door. Presentation only:
    // the tab state is this component's own, no store selector changes.
    if (identity?.pk && localStorage.getItem('cipher_new_account') === 'true') {
      setActiveTab('explore');
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
      {/* Drawer first so the shaded sheets later in the DOM keep painting
          above it — all of them share the z-sheet token now. */}
      <Drawer identity={identity} open={showDrawer} onClose={() => useChatStore.getState().setShowDrawer(false)} onNavigate={openDrawerSection} />
      {/* The one toast queue for the whole app: setToast, pushToast and every
          old status pill route through this render. */}
      <Toast />
      <TutorialModal isOpen={showTutorial} onClose={() => { useChatStore.getState().setShowTutorial(false); localStorage.removeItem('cipher_new_account'); }} />
      <DeadDropModal identity={identity} />
      <GlobalDialog />
      <CallOverlay />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenChat={openChatFromPalette}
        onNavigateTab={setActiveTab}
        activeTab={activeTab}
      />

      <main className="relative z-fab h-[100dvh] w-full max-w-md overflow-hidden md:w-auto md:max-w-none md:flex-1">
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
                  <div className="relative z-fab flex items-center px-4 pb-1 pt-3">
                    <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-ink/50 hover:text-ink md:hidden"><Menu size={20} /></button>
                    <Segmented
                      ariaLabel="Discover sections"
                      className="flex-1"
                      value={exploreMode}
                      onChange={setExploreMode}
                      options={[{ value: 'shop', label: 'Menus' }, { value: 'groups', label: 'Groups' }]}
                    />
                  </div>
                  <div className="relative z-fab min-h-0 flex-1">
                    {exploreMode === 'shop'
                      ? <Menus identity={identity} setActiveTab={setActiveTab} />
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

      <Rail
        label="Tabs"
        activeId={activeTab}
        items={[
          { id: 'chat', label: 'Chats', icon: MessageSquare, badge: unreadTotal, onSelect: () => setActiveTab('chat') },
          { id: 'explore', label: 'Menus', icon: Compass, onSelect: () => setActiveTab('explore') },
          { id: 'profile', label: 'Profile', icon: User, onSelect: () => setActiveTab('profile') },
        ]}
      />
    </div>
  );
}
