import { useState } from 'react';
import { Copy, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

const EMPTY_PROFILE = {};

export default function MyProfileModal({ identity }) {
  const isOpen = useChatStore((state) => state.showMyProfile);
  const setShowMyProfile = useChatStore((state) => state.setShowMyProfile);
  const profile = useChatStore((state) => (identity?.pk ? state.profiles[identity.pk] : undefined)) || EMPTY_PROFILE;
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  if (!isOpen) return null;

  const copyNpub = async () => {
    setError('');
    try {
      const { nip19 } = await import('nostr-tools');
      const npub = identity?.npub || (identity?.pk ? nip19.npubEncode(identity.pk) : '');
      if (!npub) throw new Error('No public key yet.');
      await navigator.clipboard.writeText(npub);
      setNotice('Copied!');
      useChatStore.getState().setToast({ type: 'success', message: 'Copied!' });
    } catch (copyError) {
      console.error('[MyProfileModal] Could not copy npub:', copyError);
      setError('Could not copy the public key.');
    }
  };

  const name = profile.displayName || profile.name || 'Your profile';
  const initial = name.slice(0, 1).toUpperCase();

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setShowMyProfile(false);
    }}>
      <section role="dialog" aria-modal="true" aria-label="My profile" className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-black p-6">
        <button type="button" onClick={() => setShowMyProfile(false)} aria-label="Close profile" className="absolute right-4 top-4 p-2 text-white/45 hover:text-white"><X size={20} /></button>
        <div className="flex items-center gap-4 pr-8">
          {profile.picture
            ? <img src={profile.picture} alt="" className="h-16 w-16 rounded-full object-cover" />
            : <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-[#111] text-xl font-bold text-blue-500">{initial}</div>}
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-white">{name}</h2>
            <p className="truncate text-[12px] text-white/35">{identity?.pk ? `${identity.pk.slice(0, 16)}…` : 'No key loaded'}</p>
          </div>
        </div>
        {profile.about && <p className="mt-4 text-sm text-white/60">{profile.about}</p>}
        <button type="button" onClick={copyNpub} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-500">
          <Copy size={16} /> Copy npub
        </button>
        {notice && <p role="status" className="mt-3 text-center text-[13px] text-blue-500">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-center text-[13px] text-red-400">{error}</p>}
      </section>
    </div>
  );
}
