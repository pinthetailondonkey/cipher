import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import TutorialModal from './components/TutorialModal';
import Rail from './components/ui/Rail';
import BottomBar from './components/ui/BottomBar';
import GlobalDialog from './components/GlobalDialog';
import CallOverlay from './components/chat/CallOverlay';
import DeadDropModal from './components/chat/DeadDropModal';
import Toast from './components/ui/Toast';
import CommandPalette from './components/ui/CommandPalette';
import { TABS } from './lib/tabs.js';
import { barUnreadTotalOf, ordersNeedActionOf, useChatStore } from './store/chatStore';

const Chat = lazy(() => import('./Chat'));
const Wallet = lazy(() => import('./Wallet'));

export default function AuthenticatedApp({ identity }) {
  const [activeTab, setActiveTab] = useState('chat');
  // The Threads segment lives here because the bar's own rule reads it (a
  // thread hides the bar, a browse does not) and the pane that draws it is
  // three levels down. One owner, so the two can never disagree. The railway
  // directory's open/closed state rides along for the same reason.
  const [threadSegment, setThreadSegment] = useState('chats');
  const [discoverOpen, setDiscoverOpen] = useState(false);
  // Every door that opens a conversation goes through here: the tab and the
  // segment that shows it move together, so a tap from the palette, a profile
  // row or a menu never lands on a browse with the thread hidden behind it.
  const goToChat = useCallback(() => {
    setDiscoverOpen(false);
    setThreadSegment('chats');
    setActiveTab('chat');
  }, []);
  // The rail's badge reads the bar's selector: one mute-and-archive-aware
  // number, so the two navs that show it can never disagree.
  const unreadTotal = useChatStore(barUnreadTotalOf);
  const needsAction = useChatStore(ordersNeedActionOf);
  const openChatFromProfile = useCallback((pubkey) => {
    useChatStore.getState().openChat('dm', pubkey);
    goToChat();
  }, [goToChat]);
  const openChatFromPalette = useCallback((type, id, group) => {
    useChatStore.getState().openChat(type, id, group || null);
    goToChat();
  }, [goToChat]);
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
  // The vendor's menu home is a sheet over the chat surface (ChatOverlays
  // draws it inside the Threads pane), so a storefront opened from anywhere —
  // the Menus browse, a chat row, Discover — brings the Threads tab back with
  // it. Nothing else has to move: the sheet sits over the browse if that is
  // where the tap came from, and over the list if it did not, and closing it
  // lands wherever the user already was.
  const vendorMenuPubkey = useChatStore((state) => state.vendorStorefrontPubkey);
  React.useEffect(() => {
    if (vendorMenuPubkey) setActiveTab('chat');
  }, [vendorMenuPubkey]);
  // A saved product link (?product=&vendor=) resolves on boot and opens its
  // checkout over the browse — the Menus segment is where a menu is. Closing
  // it leaves the seller's thread in view when one is open (its own sheet
  // lands there), because a person who just closed an order wants the chat,
  // not the shelf.
  useEffect(() => {
    return useChatStore.subscribe((state, previous) => {
      const id = state.checkoutProduct?.id || null;
      const was = previous?.checkoutProduct?.id || null;
      if (id && id !== was) {
        setThreadSegment('explore');
        setActiveTab('chat');
      }
      if (!id && was && useChatStore.getState().view !== 'list') setThreadSegment('chats');
    });
  }, [setActiveTab]);
  useEffect(() => {
    // New accounts get the walkthrough once, and land on the Menus browse —
    // browsing the network's vendors is the front door. Presentation only:
    // the tab and segment state are this component's own, no store selector
    // changes.
    if (identity?.pk && localStorage.getItem('cipher_new_account') === 'true') {
      setThreadSegment('explore');
      setActiveTab('chat');
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
  const barHidden = activeTab === 'chat' && chatView !== 'list' && threadSegment !== 'explore' && !discoverOpen;
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

  // The notification prompt is NOT fired here on mount: Privacy owns the
  // opt-in and asks the OS from the person's own tap (fix 7), so mounting the
  // authenticated app never pops a permission box by itself.

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
            {/* Threads stays mounted on every tab: its subscriptions are the
                DMs, and re-mounting them on a tab switch would re-ask the
                relays for a list that has not changed. It steps aside with
                `invisible`, never by unmounting. */}
            <div className={`absolute inset-0 ${activeTab === 'chat' ? '' : 'invisible pointer-events-none'}`}>
              <Suspense fallback={tabFallback}>
                <Chat
                  identity={identity}
                  segment={threadSegment}
                  onSegmentChange={setThreadSegment}
                  discoverOpen={discoverOpen}
                  onDiscoverChange={setDiscoverOpen}
                  onGoToChat={goToChat}
                />
              </Suspense>
            </div>
            {activeTab === 'profile' && (
              <div className="absolute inset-0">
                <Suspense fallback={tabFallback}>
                  {/* You is Wallet: identity, wallet, privacy, and the orders
                      ledger's own door (its My Orders row) — the path the
                      Orders tab used to own. */}
                  <div className="h-full w-full md:border-x md:border-line">
                    <Wallet identity={identity} onOpenChat={openChatFromProfile} />
                  </div>
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
