import { lazy, Suspense, useEffect } from 'react';
import { useChatStore } from '../../store/chatStore';
import BookmarksViewer from '../../components/chat/BookmarksViewer';
import NotificationCenter from '../../components/chat/NotificationCenter';
import QRScanner from '../../components/chat/QRScanner';
import BroadcastModal from '../../components/chat/BroadcastModal';
import ProductEditModal from '../../components/chat/ProductEditModal';

// The same loaders the lazy surfaces use, so a prefetch asks for the exact
// chunk a later tap needs — never a second copy of the fetch.
const loadProfileModal = () => import('../../components/ProfileModal');
const loadVendorMenuHome = () => import('../../components/chat/VendorMenuHome');
const ProfileModal = lazy(loadProfileModal);
const VendorMenuHome = lazy(loadVendorMenuHome);

// A tap that opens a lazy surface must answer on screen, not with nothing:
// while the chunk is still in flight this is what stands in — the app's own
// spinner (the one tabFallback and screenFallback draw) on the same dimmed
// veil and layer the sheets themselves paint. The null this boundary used to
// fall back to was the founder's blank-profile bug: the tap produced zero
// visible response, and a chunk that failed to arrive threw to the root
// error boundary and took the whole app with it.
const overlayFallback = (
  <div className="fixed inset-0 z-sheet flex items-center justify-center bg-scrim/60" role="status" aria-label="Loading">
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-ink/20 border-t-blue-500" />
  </div>
);

export default function ChatOverlays({
  identity,
  openChat,
  startOrderWithVendor,
  handleSaveEditedProduct,
  handleBroadcastSubmit,
}) {
  const groups = useChatStore((state) => state.groups);
  const profiles = useChatStore((state) => state.profiles);
  const profilePubkey = useChatStore((state) => state.profilePubkey);
  const setProfilePubkey = useChatStore((state) => state.setProfilePubkey);
  const showBookmarks = useChatStore((state) => state.showBookmarks);
  const setShowBookmarks = useChatStore((state) => state.setShowBookmarks);
  const showNotifCenter = useChatStore((state) => state.showNotifCenter);
  const setShowNotifCenter = useChatStore((state) => state.setShowNotifCenter);
  const showQRScanner = useChatStore((state) => state.showQRScanner);
  const setShowQRScanner = useChatStore((state) => state.setShowQRScanner);
  const broadcastProduct = useChatStore((state) => state.broadcastProduct);
  const setBroadcastProduct = useChatStore((state) => state.setBroadcastProduct);
  const editingProduct = useChatStore((state) => state.editingProduct);
  const setEditingProduct = useChatStore((state) => state.setEditingProduct);
  const vendorStorefrontPubkey = useChatStore((state) => state.vendorStorefrontPubkey);
  const setVendorStorefrontPubkey = useChatStore((state) => state.setVendorStorefrontPubkey);

  // Warm both lazy chunks once, the moment the overlays mount, so the first
  // real open draws the surface instead of the fallback.
  useEffect(() => {
    loadProfileModal();
    loadVendorMenuHome();
  }, []);

  const jumpBookmark = (chatId, msgId, isGroup) => {
    if (isGroup) {
      const group = groups.find((item) => item.id === chatId);
      if (group) openChat('group', chatId, group);
    } else {
      openChat('dm', chatId);
    }
    setTimeout(() => {
      const el = document.getElementById(`msg-${msgId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 500);
  };

  return (
    <Suspense fallback={overlayFallback}>
      {profilePubkey && (
        <ProfileModal
          pubkey={profilePubkey}
          identity={identity}
          onClose={() => setProfilePubkey(null)}
          onMessage={(pubkey) => { setProfilePubkey(null); openChat('dm', pubkey); }}
        />
      )}
      {showBookmarks && <BookmarksViewer onClose={() => setShowBookmarks(false)} onJump={jumpBookmark} />}
      {showNotifCenter && (
        <NotificationCenter
          onClose={() => setShowNotifCenter(false)}
          onJump={(type, id) => {
            if (type === 'group') {
              const group = groups.find((item) => item.id === id);
              if (group) openChat('group', id, group);
            } else {
              openChat('dm', id);
            }
          }}
        />
      )}
      {showQRScanner && <QRScanner onClose={() => setShowQRScanner(false)} />}
      <BroadcastModal isOpen={!!broadcastProduct} onClose={() => setBroadcastProduct(null)} product={broadcastProduct} groups={groups} onBroadcast={handleBroadcastSubmit} />
      <ProductEditModal editingProduct={editingProduct} onClose={() => setEditingProduct(null)} onSubmit={handleSaveEditedProduct} identity={identity} />
      {/* Rendered only when a storefront is actually open. Drawn at rest it
          suspended this boundary on every cold mount — and with a real
          fallback that would paint the spinner veil over a freshly booted
          shell before any surface was asked for. Gated, the boundary wakes
          only for a real open, which the prefetch above has usually already
          finished. Its own closed render was null all along. */}
      {vendorStorefrontPubkey && (
        <VendorMenuHome
          open={!!vendorStorefrontPubkey}
          onClose={() => setVendorStorefrontPubkey(null)}
          vendorPubkey={vendorStorefrontPubkey}
          profiles={profiles}
          identity={identity}
          onOpenChat={(pubkey) => openChat('dm', pubkey)}
          onBuy={(product, vendorPubkey) => startOrderWithVendor(vendorPubkey, product, product.id)}
        />
      )}
    </Suspense>
  );
}
