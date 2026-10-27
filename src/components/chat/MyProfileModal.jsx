import { useState } from 'react';
import { Copy } from 'lucide-react';
import Sheet from '../ui/Sheet';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import Button from '../ui/Button';
import { copyText } from '../../lib/copyText';
import { noHexName, shortNpub } from '../../lib/npub';

const EMPTY_PROFILE = {};

export default function MyProfileModal({ identity }) {
  const isOpen = useChatStore((state) => state.showMyProfile);
  const setShowMyProfile = useChatStore((state) => state.setShowMyProfile);
  const profile = useChatStore((state) => (identity?.pk ? state.profiles[identity.pk] : undefined)) || EMPTY_PROFILE;
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const copyNpub = async () => {
    setError('');
    try {
      const { nip19 } = await import('nostr-tools');
      const npub = identity?.npub || (identity?.pk ? nip19.npubEncode(identity.pk) : '');
      if (!npub) throw new Error('No public key yet.');
      const ok = await copyText(npub);
      if (ok) setNotice('Copied!');
    } catch (copyError) {
      console.error('[MyProfileModal] Could not copy npub:', copyError);
      setError('Could not copy the public key.');
    }
  };

  const name = noHexName(profile, identity?.pk);

  return (
    <Sheet open={isOpen} onClose={() => setShowMyProfile(false)} label="My profile">
      <div className="px-6 pt-5 pb-6">
        <div className="flex items-center gap-4 pr-8">
          <Avatar src={profile.picture} name={name} className="!h-16 !w-16 text-xl" />
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-bold tracking-tight text-ink">{name}</h2>
            <p className="truncate text-[13px] text-ink/40">{identity?.pk ? shortNpub(identity.pk) : 'No key loaded'}</p>
          </div>
        </div>
        {profile.about && <p className="mt-4 text-[13px] text-ink/40">{profile.about}</p>}
        <Button onClick={copyNpub} className="mt-5 flex w-full items-center justify-center gap-2">
          <Copy size={16} /> Copy npub
        </Button>
        {notice && <p role="status" className="mt-3 text-center text-[13px] text-accentText">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-center text-[13px] text-danger">{error}</p>}
      </div>
    </Sheet>
  );
}
