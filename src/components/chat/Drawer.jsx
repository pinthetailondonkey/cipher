import { AnimatePresence, motion } from 'framer-motion';
import { Lock, MessageSquare, Package, Radio, ShieldCheck, Store, Users } from 'lucide-react';
import Avatar from '../ui/Avatar';
import Picture from '../ui/Picture';
import { unreadTotalOf, useChatStore } from '../../store/chatStore';
import { useProfiles } from '../../useProfiles';

// The phone shell's side drawer: profile card up top, then the sections,
// relay connections and the lock. The desktop left rail covers md+; this
// only ever mounts below md. onNavigate(tab, exploreMode, startView) hands
// the tap back to AuthenticatedApp, which owns the tab state.
export default function Drawer({ identity, open, onClose, onNavigate }) {
  const unreadTotal = useChatStore(unreadTotalOf);
  const profiles = useProfiles([identity.pk]);
  const myProfile = profiles[identity.pk] || {};
  const defaultName = identity.npub ? identity.npub.slice(0, 10) : 'User';
  const name = myProfile.displayName || myProfile.name || defaultName;

  const sections = [
    { key: 'chats', label: 'Chats', icon: MessageSquare, go: () => onNavigate('chat'), badge: unreadTotal },
    { key: 'menus', label: 'Menus', icon: Store, go: () => onNavigate('explore', 'shop') },
    { key: 'orders', label: 'Orders', icon: Package, go: () => onNavigate('profile', null, 'orders') },
    { key: 'groups', label: 'Groups', icon: Users, go: () => onNavigate('explore', 'groups') },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div key="drawer" className="fixed inset-0 z-[100] md:hidden">
          <motion.button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 touch-target bg-scrim/60"
          />
          <motion.aside
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            className="absolute left-0 top-0 flex h-full w-[300px] max-w-[84%] flex-col overflow-y-auto border-r border-line bg-panel pb-safe pt-safe shadow-2xl"
          >
            <button type="button" onClick={() => onNavigate('profile')} className="flex items-center gap-3 p-4 pb-5 text-left active:bg-ink/5">
              <Picture src={myProfile.picture} alt="" className="h-14 w-14 rounded-full border border-ink/10 object-cover" fallback={<Avatar name={name} className="!h-14 !w-14" />} />
              <span className="min-w-0">
                <span className="block truncate text-lg font-bold tracking-tight text-ink">{name}</span>
                <span className="mono mt-0.5 flex items-center gap-1 text-[11px] text-ink/40">
                  <ShieldCheck size={12} className="shrink-0" />
                  {identity.npub ? `${identity.npub.slice(0, 10)}…${identity.npub.slice(-4)}` : ''}
                </span>
              </span>
            </button>

            <nav className="flex flex-col">
              {sections.map(({ key, label, icon: Icon, go, badge }) => (
                <button key={key} type="button" onClick={go} className="flex min-h-[48px] w-full items-center gap-4 px-5 text-left text-[15px] font-semibold text-ink active:bg-ink/5">
                  <Icon size={20} className="text-ink/45" />
                  <span className="flex-1">{label}</span>
                  {badge > 0 && (
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">{badge > 99 ? '99+' : badge}</span>
                  )}
                </button>
              ))}
              <div className="my-2 border-t border-line" />
              <button type="button" onClick={() => onNavigate('profile', null, 'connections')} className="flex min-h-[48px] w-full items-center gap-4 px-5 text-left text-[15px] font-semibold text-ink active:bg-ink/5">
                <Radio size={20} className="text-ink/45" />
                <span className="flex-1">Connections</span>
              </button>
              <button type="button" onClick={identity.lockApp} className="flex min-h-[48px] w-full items-center gap-4 px-5 text-left text-[15px] font-semibold text-ink active:bg-ink/5">
                <Lock size={20} className="text-ink/45" />
                <span className="flex-1">Lock now</span>
              </button>
            </nav>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
