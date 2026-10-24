import { useState } from 'react';
import { BadgeCheck, Heart, MessageCircle, X } from 'lucide-react';
import { useProfiles } from '../useProfiles';
import { useVouchCount } from '../hooks/useVouchCount';
import { useReputation } from '../hooks/useReputation';

export default function ProfileModal({ pubkey, identity, onClose, onMessage }) {
  const profiles = useProfiles(pubkey ? [pubkey] : []);
  const profile = profiles[pubkey] || {};
  const { vouchCount, loading, hasVouched, refresh } = useVouchCount({ identity, targetPubkey: pubkey });
  const { sendVouch } = useReputation({ identity });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  if (!pubkey) return null;

  const isSelf = identity?.pk === pubkey;
  const vouchForVendor = async () => {
    setSending(true);
    setError('');
    setNotice('');
    const result = await sendVouch(pubkey);
    setSending(false);
    if (!result.success) {
      setError(result.error || 'Could not publish your vouch.');
      return;
    }
    setNotice(result.queued ? 'Your vouch is saved and will publish when connected.' : 'Your vouch was published.');
    refresh();
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Profile" className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-6">
        <button type="button" onClick={onClose} aria-label="Close profile" className="absolute right-4 top-4 p-2 text-white/45 hover:text-white"><X size={20} /></button>
        <div className="flex items-center gap-4 pr-8">
          {profile.picture
            ? <img src={profile.picture} alt="" className="h-16 w-16 rounded-full border border-white/10 object-cover" />
            : <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-[#111] text-xl font-bold text-white/60">{(profile.displayName || profile.name || pubkey).slice(0, 1).toUpperCase()}</div>}
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-white">{profile.displayName || profile.name || `User ${pubkey.slice(0, 8)}`}</h2>
            <p className="truncate text-[12px] text-white/35">{pubkey.slice(0, 16)}…</p>
          </div>
        </div>
        {profile.about && <p className="mt-4 whitespace-pre-wrap text-sm text-white/60">{profile.about}</p>}
        {!isSelf && identity?.sk && onMessage && (
          <button type="button" onClick={() => onMessage(pubkey)} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-500">
            <MessageCircle size={17} /> Message
          </button>
        )}
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-white/10 bg-[#111] px-4 py-3">
          <BadgeCheck size={19} className={vouchCount >= 3 ? 'text-blue-400' : 'text-white/35'} />
          <span className="flex-1 text-sm text-white/70">{loading ? 'Checking vouches…' : `${vouchCount} vouch${vouchCount === 1 ? '' : 'es'}`}</span>
          {vouchCount >= 3 && <span className="text-xs font-semibold text-blue-400">Trusted Vendor</span>}
        </div>
        {!isSelf && identity?.sk && (
          <button type="button" onClick={vouchForVendor} disabled={sending || hasVouched} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
            <Heart size={16} /> {hasVouched ? 'You vouched' : sending ? 'Publishing…' : 'Vouch for this person'}
          </button>
        )}
        {notice && <p role="status" className="mt-3 text-center text-[13px] text-emerald-400">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-center text-[13px] text-red-400">{error}</p>}
      </section>
    </div>
  );
}
