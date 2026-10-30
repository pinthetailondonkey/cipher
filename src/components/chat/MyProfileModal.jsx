import { useState } from 'react';
import { Copy, Link2 as LinkIcon } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';
import Avatar from '../ui/Avatar';
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

  // The link shape the boot reader already walks (?chat=<npub>):
  // whoever opens it lands straight in a chat with this identity. The
  // raw npub stays the other affordance — not everyone copies into a
  // browser address bar.
  const copyChatLink = async () => {
    setError('');
    try {
      const { nip19 } = await import('nostr-tools');
      const npub = identity?.npub || (identity?.pk ? nip19.npubEncode(identity.pk) : '');
      if (!npub) throw new Error('No public key yet.');
      const link = `${window.location.origin}${window.location.pathname}?chat=${encodeURIComponent(npub)}`;
      const ok = await copyText(link);
      if (ok) setNotice('Copied!');
    } catch (linkError) {
      console.error('[MyProfileModal] Could not copy chat link:', linkError);
      setError('Could not copy the link.');
    }
  };

  const name = noHexName(profile, identity?.pk);

  return (
    // The card draws its own header: the person's own name. bareHeader keeps
    // the shared bar from drawing a second one above it, and labelledBy names
    // the dialog after the heading that is actually on screen.
    <Sheet open={isOpen} onClose={() => setShowMyProfile(false)} label="My profile" labelledBy="my-profile-name" bareHeader>
      <div className="pb-4">
        <div className="flex items-center gap-4">
          <Avatar src={profile.picture} name={name} size="lg" />
          <div className="min-w-0">
            <h2 id="my-profile-name" className="truncate text-[22px] font-bold tracking-tight text-ink">{name}</h2>
            <p className="truncate text-[13px] text-inkMuted">{identity?.pk ? shortNpub(identity.pk) : 'No key loaded'}</p>
          </div>
        </div>
        {profile.about && <p className="mt-4 text-[13px] text-inkMuted">{profile.about}</p>}
        <Button onClick={copyNpub} fullWidth className="mt-5">
          <Copy size={16} className="mr-1 inline" /> Copy npub
        </Button>
        <button
          type="button"
          onClick={copyChatLink}
          className="mt-2 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full border border-line text-[15px] font-bold text-ink"
        >
          <LinkIcon size={16} /> Copy link to chat with me
        </button>
        {notice && <p role="status" className="mt-3 text-center text-[13px] text-accentText">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-center text-[13px] text-danger">{error}</p>}
      </div>
    </Sheet>
  );
}
