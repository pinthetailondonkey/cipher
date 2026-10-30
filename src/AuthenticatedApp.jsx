import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import TutorialModal from './components/TutorialModal';
import Rail from './components/ui/Rail';
import BottomBar from './components/ui/BottomBar';
import Drawer from './components/chat/Drawer';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import DeadDropModal from './components/chat/DeadDropModal';
import Toast from './components/ui/Toast';
import Segmented from './components/ui/Segmented';
import CommandPalette from './components/ui/CommandPalette';
import { requestNotificationPermission } from './lib/notifications';
import { TABS } from './lib/tabs.js';
import { barUnreadTotalOf, ordersNeedActionOf, useChatStore } from './store/chatStore';

const Menus = lazy(() => import('./Menus'));
const Discover = lazy(() => import('./Discover'));
const Chat = lazy(() => import('./Chat'));
const Wallet = lazy(() => import('./Wallet'));
const MyOrders = lazy(() => import('./components/chat/MyOrders'));

export default function AuthenticatedApp({ identity }) {
  const [activeTab, setActiveTab] = useState('chat');
  // The rail's badge reads the bar's selector: one mute-and-archive-aware
  // number, so the two navs that show it can never disagree.
  const unreadTotal = useChatStore(barUnreadTotalOf);
  const needsAction = useChatStore(ordersNeedActionOf);
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

  // The chat view decides the bar, not the tab: inside a conversation the
  // thread owns the whole screen, so the bar steps aside; on every other
  // tab the bar holds. The store's view is NOT reset on tab switches, so
  // the gate has to name the chat tab, not just the view (UI-SPEC: the bar
  // hides inside a conversation, nowhere else).
  const chatView = useChatStore((state) => state.view);
  const barHidden = activeTab === 'chat' && chatView !== 'list';
  // The md+ rail and the below-md bar read the same set — tabs.js — so the
  // two navs can never disagree about what exists or in what order. ⌘1–⌘4
  // ride the items' positions in the Rail. Badge keys resolve to counts
  // here once; both navs render them.
  const badgeCounts = { unread: unreadTotal, needsAction };
  // Row 1 of the shell (§3.4). Null today, and deliberately not a duplicate:
  // each tab's own bar is still rendered by its screen, and rendering a second
  // one here would put two 56px bars on the same screen. Chat's is blocked on
  // `fetchChats` (Chat.jsx, another lane's file) and the rest belong to their
  // own gates; this seam is where they land, one screen at a time.
  const tabHeader = null;
  const navItems = TABS.map((tab) => ({
    ...tab,
    badge: tab.badge ? badgeCounts[tab.badge] : undefined,
    onSelect: () => setActiveTab(tab.id),
  }));

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

      {/* The column and the rows (brief §3.2, §3.3). main is the flex sibling
          the Rail leaves behind, and the column inside it is the one width
          every pane shares — no pane sets a max-width of its own. The bar is
          row three, not an overlay: three rows when the bar holds, two when a
          conversation takes the screen (trap 8). z-fab stays on main, because
          Sheet relies on main being a stacking context (trap 2). */}
      {/* The rail comes first: it is the flex sibling main is `flex-1`
          beside, and DOM order has to match what the eye sees — a nav
          placed after main would read last to a keyboard and paint left. */}
      <Rail label="Tabs" activeId={activeTab} items={navItems} />

      <main className="relative z-fab h-[100dvh] min-h-0 w-full overflow-hidden md:flex-1">
        <div className={`col-w mx-auto grid h-full ${barHidden ? 'grid-rows-[auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)_auto]'}`}>
          {/* Row 1 is the shell's own: it renders from a per-tab header config
              (§3.4). The seam is here and empty until each screen hands its
              bar over — the chat bar still needs `fetchChats`, which Chat.jsx
              owns, so ChatList keeps that one. An empty row 1 collapses to
              nothing; the content sits in row 2 by name and the bar lands in
              row 3, so the two-row template drops the bar without moving
              anything else (trap 8). */}
          <div className="row-start-1">{tabHeader}</div>
          <div className="relative row-start-2 min-h-0 overflow-hidden">
            <div className={`absolute inset-0 ${activeTab === 'chat' ? '' : 'invisible pointer-events-none'}`}>
              <Suspense fallback={tabFallback}>
                <Chat identity={identity} />
              </Suspense>
            </div>
            {activeTab !== 'chat' && (
              <div className="absolute inset-0">
                <Suspense fallback={tabFallback}>
                  {activeTab === 'explore' && (
                    <div className="relative flex h-full w-full flex-col md:border-x md:border-line">
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
                  {activeTab === 'orders' && (
                    <div className="h-full w-full md:border-x md:border-line">
                      {/* The Orders tab is MyOrders directly, no drawer detour and
                          no back arrow: role-aware inside (buyer rows are the
                          requests this device sent, vendor rows the ones it
                          received), and the kebab opens the drawer for the rest. */}
                      <MyOrders identity={identity} onOpenChat={openChatFromProfile} onMenu={() => useChatStore.getState().setShowDrawer(true)} />
                    </div>
                  )}
                  {activeTab === 'profile' && (
                    <div className="h-full w-full md:border-x md:border-line">
                      <Wallet key={profileNavNonce} identity={identity} onOpenChat={openChatFromProfile} startView={profileStartView} />
                    </div>
                  )}
                </Suspense>
              </div>
            )}
          </div>
          {!barHidden && <BottomBar activeId={activeTab} onSelect={setActiveTab} />}
        </div>
      </main>
    </div>
  );
}
