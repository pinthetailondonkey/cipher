import { lazy, Suspense } from 'react';
import { useChatStore } from '../../store/chatStore';
import BookmarksViewer from '../../components/chat/BookmarksViewer';
import NotificationCenter from '../../components/chat/NotificationCenter';
import QRScanner from '../../components/chat/QRScanner';
import BroadcastModal from '../../components/chat/BroadcastModal';
import ProductEditModal from '../../components/chat/ProductEditModal';

const ProfileModal = lazy(() => import('../../components/ProfileModal'));
const VendorMenuHome = lazy(() => import('../../components/chat/VendorMenuHome'));

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
    <Suspense fallback={null}>
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
      <VendorMenuHome
        open={!!vendorStorefrontPubkey}
        onClose={() => setVendorStorefrontPubkey(null)}
        vendorPubkey={vendorStorefrontPubkey}
        profiles={profiles}
        identity={identity}
        onOpenChat={(pubkey) => openChat('dm', pubkey)}
        onBuy={(product, vendorPubkey) => startOrderWithVendor(vendorPubkey, product, product.id)}
      />
    </Suspense>
  );
}
