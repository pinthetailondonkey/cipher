import { useState } from 'react';
import { BadgeCheck, Ban, Copy, Heart, MessageCircle } from 'lucide-react';
import { useProfiles } from '../useProfiles';
import { useVouchCount } from '../hooks/useVouchCount';
import { useReputation } from '../hooks/useReputation';
import Sheet from './ui/Sheet';
import Avatar from './ui/Avatar';
import Button from './ui/Button';
import { copyText } from '../lib/copyText';
import { readPublicViews } from '../lib/proofOfTrade';
import { noHexName, shortNpub } from '../lib/npub';
import { useChatStore } from '../store/chatStore';

// Stable id so the sheet can name its dialog from the name it shows.
const NAME_ID = 'profile-card-name';

export default function ProfileModal({ pubkey, identity, onClose, onMessage }) {
  // The card opens with the profile the store already holds — the same map
  // the chat header draws its title from — and useProfiles refreshes it from
  // the device's own cache and the relays on top. Reading only the cache left
  // a cold open nameless and pictureless, even while the header behind the
  // card already showed both. The fetched copy wins once it lands: both read
  // the same saved row.
  const storedProfile = useChatStore((state) => (pubkey ? state.profiles[pubkey] : undefined));
  const fetched = useProfiles(pubkey ? [pubkey] : []);
  const profile = fetched[pubkey] || storedProfile || {};
  const { vouchCount, loading, hasVouched, refresh } = useVouchCount({ identity, targetPubkey: pubkey });
  const { sendVouch } = useReputation({ identity });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const blocked = useChatStore((state) => (pubkey ? state.blockedUsers.includes(pubkey) : false));
  const toggleBlockUser = useChatStore((state) => state.toggleBlockUser);
  if (!pubkey) return null;
  const isSelf = identity?.pk === pubkey;

  const copyNpub = async () => {
    try {
      const { nip19 } = await import('nostr-tools');
      const ok = await copyText(nip19.npubEncode(pubkey));
      if (ok) setNotice('Copied!');
    } catch (copyError) {
      console.error('[ProfileModal] Could not copy npub:', copyError);
      setError('Could not copy the public key.');
    }
  };
  const vouchForVendor = async () => {
    setSending(true);
    setError('');
    setNotice('');
    // S8: a vouch binds to the receipt hash of a trade with this vendor that
    // this device holds a public view of, and publishes the trade's own
    // vendor and buyer under this signature, so the vouch cannot be
    // transplanted onto a trade it does not belong to. Never been traded,
    // no vouch.
    const traded = readPublicViews().find((view) => view?.hash && (
      view.vendor === pubkey || view.buyer === pubkey
    ));
    const result = await sendVouch(pubkey, traded?.hash || '', traded ? { vendor: traded.vendor, buyer: traded.buyer } : null);
    setSending(false);
    if (!result.success) {
      setError(result.error || 'Could not publish your vouch.');
      return;
    }
    setNotice(result.queued ? 'Your vouch is saved and will publish when connected.' : 'Your vouch was published.');
    refresh();
  };

  const block = () => {
    if (blocked) {
      toggleBlockUser(pubkey);
      setNotice('Unblocked.');
      return;
    }
    useChatStore.getState().openDialog({
      title: 'Block this person?',
      message: 'Their new messages, calls and group posts are dropped on this device. They are not told.',
      type: 'danger',
      confirmText: 'Block',
      onConfirm: () => {
        toggleBlockUser(pubkey);
        setNotice('Blocked. Unblock from Privacy or here.');
      },
    });
  };

  // The card draws its own header: the person's name. bareHeader keeps the
  // shared bar from drawing a second one, and labelledBy names the dialog
  // from the heading that is actually on screen.
  return (
    <Sheet open={!!pubkey} onClose={onClose} label="Profile" labelledBy={NAME_ID} bareHeader>
      <section className="px-6 pb-6 pt-4">
        <div className="flex items-center gap-4">
          <Avatar src={profile.picture} name={profile.displayName || profile.name || pubkey} className="!h-16 !w-16 text-xl" />
          <div className="min-w-0">
            <h2 id={NAME_ID} className="truncate text-2xl font-bold tracking-tight text-ink">{noHexName(profile, pubkey)}</h2>
            <p className="truncate text-[13px] text-ink/40">{shortNpub(pubkey)}</p>
          </div>
        </div>
        {profile.about && <p className="mt-4 whitespace-pre-wrap text-[13px] text-ink/40">{profile.about}</p>}
        <Button variant="secondary" onClick={copyNpub} className="mt-5 flex w-full items-center justify-center gap-2">
          <Copy size={16} /> Copy npub
        </Button>
        {!isSelf && identity?.sk && onMessage && (
          <Button onClick={() => onMessage(pubkey)} className="mt-3 flex w-full items-center justify-center gap-2">
            <MessageCircle size={17} /> Message
          </Button>
        )}
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-line bg-panelStrong shadow-lg px-4 py-3">
          <BadgeCheck size={19} className={vouchCount >= 3 ? 'text-accent' : 'text-ink/35'} />
          <span className="flex-1 text-sm text-ink/70">{loading ? 'Checking vouches…' : `${vouchCount} vouch${vouchCount === 1 ? '' : 'es'}`}</span>
          {vouchCount >= 3 && <span className="text-xs font-semibold text-accent">Trusted Vendor</span>}
        </div>
        {!isSelf && identity?.sk && (
          <Button onClick={vouchForVendor} disabled={sending || hasVouched} className="mt-4 flex w-full items-center justify-center gap-2">
            <Heart size={16} /> {hasVouched ? 'You vouched' : sending ? 'Publishing…' : 'Vouch for this person'}
          </Button>
        )}
        {!isSelf && identity?.sk && (
          <Button variant="secondary" onClick={block} className="mt-3 flex w-full items-center justify-center gap-2 text-rose-300">
            <Ban size={16} /> {blocked ? 'Unblock' : 'Block'}
          </Button>
        )}
        {notice && <p role="status" className="mt-3 text-center text-[13px] text-success">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-center text-[13px] text-danger">{error}</p>}
      </section>
    </Sheet>
  );
}
