import { lazy, Suspense, useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import EmptyState from './components/ui/EmptyState';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useNIP29Group } from './hooks/useNIP29Group';
import { useReactions } from './hooks/useReactions';
import { useReputation } from './hooks/useReputation';
import { reactionSubscriptionKey, useChatStore } from './store/chatStore';
import SearchView from './components/chat/SearchView';
import ChatLoading from './features/chat/ChatLoading';
import ChatHome from './features/chat/ChatHome';
import ChatOverlays from './features/chat/ChatOverlays';
import GroupWaiting from './components/chat/GroupWaiting';
import { useMyGroups, useGroupDirectory } from './features/chat/useGroupDirectory';
import { useChatBootstrap } from './features/chat/useChatBootstrap';
import OneTapCheckout from './components/OneTapCheckout';
import { useCommerce } from './features/chat/useCommerce';
import { useComposer } from './features/chat/useComposer';
import { useMessageCommands } from './features/chat/useMessageCommands';
import { usePeopleSearch } from './features/chat/usePeopleSearch';
import { bindCallTransport } from './lib/voiceCall';

const DmView = lazy(() => import('./components/chat/DmView'));
const GroupView = lazy(() => import('./components/chat/GroupView'));

const screenFallback = (
  <div className="flex h-full items-center justify-center bg-scrim">
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-ink/20 border-t-blue-500" />
  </div>
);

export default function Chat({
  identity,
  segment,
  onSegmentChange,
  discoverOpen,
  onDiscoverChange,
  onGoToChat,
}) {
  const { sendDM, subscribeToDMs, sendTypingIndicator, fetchDMs } = useNIP44DM({ identity });
  const {
    sendGroupMessage, subscribeToGroups, pinMessage, unpinMessage, fetchPinnedMessage,
    sendGroupTypingIndicator, createGroup: createGroupHook, fetchGroupMembers,
  } = useNIP29Group({ identity });
  const { sendReaction, subscribeToReactions, subscribeToGroupReactions } = useReactions({ identity });
  const { sendVouch } = useReputation({ identity });
  const setGroups = useMyGroups(identity?.pk);
  const directory = useGroupDirectory({ identity, createGroupHook, setGroups });
  const { fetchChats } = useChatBootstrap({
    identity,
    fetchDMs,
    subscribeToDMs,
    subscribeToGroups,
    subscribeToGroupReactions,
    sendTypingIndicator,
    sendDM,
    sendGroupTypingIndicator,
    fetchGroupMembers,
    setGroups,
    fetchGroups: directory.fetchGroups,
    joinGroupById: directory.joinGroupById,
  });
  const commerce = useCommerce({
    identity,
    sendDM,
    sendGroupMessage,
    sendVouch,
    openChat: directory.openChat,
  });
  // The checkout product the group listing and chat product Buy taps set:
  // the same store key the Menus pane reads, so one sheet serves both.
  const checkoutProduct = useChatStore((s) => s.checkoutProduct);
  const composer = useComposer({ identity, sendDM, sendGroupMessage });
  const commands = useMessageCommands({
    identity,
    sendReaction,
    pinMessage,
    handleOrderAction: commerce.handleOrderAction,
    startOrderWithVendor: commerce.startOrderWithVendor,
  });
  const { handleSearch } = usePeopleSearch({ identity });

  useEffect(() => {
    bindCallTransport((pubkey, payload) => sendDM(pubkey, payload));
  }, [sendDM]);

  const reactionKey = useChatStore(reactionSubscriptionKey);

  useEffect(() => {
    const ids = reactionKey ? reactionKey.split(',').filter(Boolean) : [];
    if (!ids.length) return undefined;
    return subscribeToReactions(ids);
  }, [reactionKey, subscribeToReactions]);

  const loading = useChatStore((state) => state.loading);
  const view = useChatStore((state) => state.view);
  const activeDm = useChatStore((state) => state.activeDm);
  const activeGroup = useChatStore((state) => state.activeGroup);
  const setView = useChatStore((state) => state.setView);

  if (loading) return <ChatLoading />;

  const threadProps = {
    identity,
    sendMessage: composer.sendMessage,
    // Forward re-sends through the existing direct-message actor only.
    sendDM,
    handleMessageAction: commands.handleMessageAction,
    handleImageUpload: composer.handleImageUpload,
    startRecording: composer.startRecording,
    stopRecording: composer.stopRecording,
    cancelRecording: composer.cancelRecording,
  };

  const thread = (view === 'dm' && activeDm) ? (
    <Suspense fallback={screenFallback}>
      <DmView {...threadProps} />
    </Suspense>
  ) : (view === 'group' && activeGroup && activeGroup.membership === 'pending') ? (
    // A join the relay has not confirmed shows the waiting state and mounts
    // no group read at all: the reads are the thing that would be refused.
    <GroupWaiting group={activeGroup} onBack={() => setView('list')} />
  ) : (view === 'group' && activeGroup) ? (
    <Suspense fallback={screenFallback}>
      <GroupView
        {...threadProps}
        fetchGroupMembers={fetchGroupMembers}
        fetchPinnedMessage={fetchPinnedMessage}
        pinMessage={pinMessage}
        unpinMessage={unpinMessage}
      />
    </Suspense>
  ) : null;

  // Two panes from md up: the chat list stays on the left and the open
  // thread sits beside it. Below md only one pane ever shows, so the
  // phone keeps its full-screen swap driven by view alone.
  //
  // A browse — the Menus segment or the directory one door in — owns the
  // whole surface at every width: a grid has nothing to say beside a pane it
  // is not talking to, and the thread it covers is exactly where the user is
  // not looking. Search still wins the screen, because the compose button in
  // that header opens it from the browse too.
  const browsing = (segment === 'explore' || discoverOpen) && view !== 'search';
  const listShown = view === 'list' || browsing;

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className={`relative min-h-0 flex-1 flex-col overflow-hidden ${listShown ? 'flex' : 'hidden'} ${browsing ? '' : 'md:w-[340px] md:flex-none md:border-r md:border-line'} md:flex`}>
        <ChatHome
          identity={identity}
          openChat={directory.openChat}
          createGroup={directory.createGroup}
          fetchChats={fetchChats}
          segment={segment}
          onSegmentChange={onSegmentChange}
          discoverOpen={discoverOpen}
          onDiscoverChange={onDiscoverChange}
          onGoToChat={onGoToChat}
        />
      </div>
      <div className={`relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${listShown ? 'hidden' : 'flex'} ${browsing ? '' : 'md:flex'}`}>
        {view === 'search' ? (
          <SearchView
            handleSearch={handleSearch}
            joinGroupById={directory.joinGroupById}
            openChat={directory.openChat}
          />
        ) : thread || (
          /* The shared EmptyState, not a card: DESIGN.md's own rule is that an
             empty list is quiet, not boxed, and "screens do not hand-roll an
             empty state". The card this replaces was also 100% + 32 wide inside
             a 140px md+ pane, so its right border was cut; EmptyState carries
             its own gutter and needs no width arithmetic. */
          <EmptyState
            className="m-auto"
            icon={<MessageSquare size={24} />}
            title="No chat open"
            line="Pick a chat from the list."
          />
        )}
      </div>
      <ChatOverlays
        identity={identity}
        openChat={directory.openChat}
        startOrderWithVendor={commerce.startOrderWithVendor}
        handleSaveEditedProduct={commerce.handleSaveEditedProduct}
        handleBroadcastSubmit={commerce.handleBroadcastSubmit}
      />
      {/* The checkout the group listing and chat product Buy taps open —
          the same sheet the Menus pane draws. It rides this thread view so
          closing it lands in the seller's DM without moving tabs. */}
      {checkoutProduct && (
        <OneTapCheckout
          product={checkoutProduct}
          identity={identity}
          onConfirmOrder={commerce.beginOrderWithVendor}
          onJumpToChat={() => {
            const vendor = checkoutProduct.vendorPubkey;
            useChatStore.getState().setCheckoutProduct(null);
            if (vendor) directory.openChat('dm', vendor);
          }}
          onClose={() => {
            const vendor = checkoutProduct.vendorPubkey;
            useChatStore.getState().setCheckoutProduct(null);
            if (vendor) directory.openChat('dm', vendor);
          }}
        />
      )}
    </div>
  );
}
