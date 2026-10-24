import { useState } from 'react';
import { useProfiles, updateProfileCache } from '../../useProfiles';
import { useChatStore } from '../../store/chatStore';
import { getPrivacy } from '../../lib/privacy';
import ScreenHeader from '../ui/ScreenHeader';
import { pressable } from '../ui/Button';

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

  return (
    <div className="h-full overflow-y-auto bg-black pb-24">
      <form onSubmit={publishProfile}>
        <ScreenHeader title="Edit Profile" onBack={onClose} />
        <label className="block border-b border-white/5 px-4 py-3">
          <span className="text-[13px] text-white/40">Username</span>
          <input value={values.name} onChange={(event) => setDraft((current) => ({ ...values, ...current, name: event.target.value }))} className="mt-1 w-full bg-transparent text-[15px] text-white outline-none" maxLength={64} />
        </label>
        <label className="block border-b border-white/5 px-4 py-3">
          <span className="text-[13px] text-white/40">Display name</span>
          <input value={values.displayName} onChange={(event) => setDraft((current) => ({ ...values, ...current, displayName: event.target.value }))} className="mt-1 w-full bg-transparent text-[15px] text-white outline-none" maxLength={64} />
        </label>
        <label className="block border-b border-white/5 px-4 py-3">
          <span className="text-[13px] text-white/40">About</span>
          <textarea value={values.about} onChange={(event) => setDraft((current) => ({ ...values, ...current, about: event.target.value }))} className="mt-1 w-full resize-none bg-transparent text-[15px] text-white outline-none" rows={3} maxLength={500} />
        </label>
        <label className="block border-b border-white/5 px-4 py-3">
          <span className="text-[13px] text-white/40">Picture URL</span>
          <input type="url" value={values.picture} onChange={(event) => setDraft((current) => ({ ...values, ...current, picture: event.target.value }))} className="mt-1 w-full bg-transparent text-[15px] text-white outline-none" maxLength={2048} />
        </label>
        {message && <p role="status" className={`px-4 py-3 text-[13px] ${/could not|unlock|error|no relay/i.test(message) ? 'text-red-400' : 'text-blue-500'}`}>{message}</p>}
        <button type="submit" disabled={saving} className={`w-full px-4 py-4 text-left text-[15px] font-semibold text-blue-500 disabled:opacity-40 ${pressable}`}>
          {saving ? 'Publishing…' : 'Publish profile'}
        </button>
      </form>
    </div>
  );
}
