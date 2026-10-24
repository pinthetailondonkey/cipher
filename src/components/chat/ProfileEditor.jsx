import { useState } from 'react';
import { useProfiles, updateProfileCache } from '../../useProfiles';
import { useChatStore } from '../../store/chatStore';
import { getPrivacy } from '../../lib/privacy';
import ScreenHeader from '../ui/ScreenHeader';
import { AtSign, Image, Type, User } from 'lucide-react';

const PROFILE_RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io'];

export default function ProfileEditor({ identity, onClose }) {
  const profiles = useProfiles([identity?.pk]);
  const profile = profiles[identity?.pk] || {};
  const [draft, setDraft] = useState(null);
  const values = draft || {
    name: profile.name || '',
    displayName: profile.displayName || profile.name || '',
    about: profile.about || '',
    picture: profile.picture || '',
  };
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const publishProfile = async (event) => {
    event.preventDefault();
    if (!identity?.sk || !identity?.pk) {
      const text = 'Unlock your account before editing your profile.';
      setMessage(text);
      useChatStore.getState().setToast({ type: 'error', message: text });
      return;
    }
    setSaving(true);
    setMessage('');
    let pool;
    try {
      const { SimplePool, finalizeEvent } = await import('nostr-tools');
      pool = new SimplePool();
      const nostrEvent = finalizeEvent({
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          name: values.name.trim(),
          display_name: values.displayName.trim(),
          about: values.about.trim(),
          picture: getPrivacy().profilePhoto === 'nobody' ? '' : values.picture.trim(),
        }),
      }, identity.sk);
      const results = await Promise.allSettled(pool.publish(PROFILE_RELAYS, nostrEvent));
      const published = results.some((result) => result.status === 'fulfilled');
      if (!published) throw new Error('No relay accepted the profile update.');
      const updated = {
        name: values.name.trim(),
        displayName: values.displayName.trim(),
        about: values.about.trim(),
        picture: values.picture.trim() || null,
      };
      updateProfileCache(identity.pk, updated);
      setMessage('Profile published.');
    } catch (error) {
      console.error('[ProfileEditor] Profile publish failed:', error);
      const text = error?.message || 'Could not save your profile.';
      setMessage(text);
      useChatStore.getState().setToast({ type: 'error', message: text });
    } finally {
      pool?.close(PROFILE_RELAYS);
      setSaving(false);
    }
  };

  const set = (key) => (event) => setDraft((current) => ({ ...values, ...current, [key]: event.target.value }));
  const field = 'w-full bg-transparent text-[15px] text-white outline-none placeholder:text-white/30';

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-8">
      <form onSubmit={publishProfile} className="space-y-4">
        <ScreenHeader title="Edit Profile" onBack={onClose} />
        <div className="space-y-4 px-4">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
            <label className="flex items-center gap-3 border-b border-white/5 p-4">
              <AtSign size={18} className="shrink-0 text-white/40" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-white/40">Username</span>
                <input value={values.name} onChange={set('name')} className={field} maxLength={64} />
              </span>
            </label>
            <label className="flex items-center gap-3 border-b border-white/5 p-4">
              <User size={18} className="shrink-0 text-white/40" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-white/40">Display name</span>
                <input value={values.displayName} onChange={set('displayName')} className={field} maxLength={64} />
              </span>
            </label>
            <label className="flex items-start gap-3 border-b border-white/5 p-4">
              <Type size={18} className="mt-1 shrink-0 text-white/40" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-white/40">About</span>
                <textarea value={values.about} onChange={set('about')} className={`${field} resize-none`} rows={3} maxLength={500} />
              </span>
            </label>
            <label className="flex items-center gap-3 p-4">
              <Image size={18} className="shrink-0 text-white/40" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-white/40">Picture URL</span>
                <input type="url" value={values.picture} onChange={set('picture')} className={field} maxLength={2048} placeholder="https://" />
              </span>
            </label>
          </div>
          {message && <p role="status" className={`text-[13px] ${/could not|unlock|error|no relay/i.test(message) ? 'text-red-400' : 'text-blue-500'}`}>{message}</p>}
          <button type="submit" disabled={saving} className="w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500 active:scale-95 disabled:opacity-50">
            {saving ? 'Publishing…' : 'Publish profile'}
          </button>
        </div>
      </form>
    </div>
  );
}
