import { useState } from 'react';
import { ArrowLeft, RefreshCw, Save, X } from 'lucide-react';
import { useProfiles, updateProfileCache } from '../../useProfiles';

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
      setMessage('Unlock your account before editing your profile.');
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
          picture: values.picture.trim(),
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
      setMessage(error?.message || 'Could not publish your profile.');
    } finally {
      pool?.close(PROFILE_RELAYS);
      setSaving(false);
    }
  };

  const inputClass = 'w-full rounded-xl border border-white/10 bg-[#111] p-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-blue-500';

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Edit profile">
      <form onSubmit={publishProfile} className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-6">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="p-1 text-white/50 hover:text-white" aria-label="Back"><ArrowLeft size={20} /></button>
            <h2 className="text-xl font-bold text-white">Edit Profile</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close"><X size={20} /></button>
        </div>
        <div className="space-y-4">
          <label className="block text-[13px] text-white/40">Username<input value={values.name} onChange={(event) => setDraft((current) => ({ ...values, ...current, name: event.target.value }))} className={`${inputClass} mt-1`} maxLength={64} /></label>
          <label className="block text-[13px] text-white/40">Display name<input value={values.displayName} onChange={(event) => setDraft((current) => ({ ...values, ...current, displayName: event.target.value }))} className={`${inputClass} mt-1`} maxLength={64} /></label>
          <label className="block text-[13px] text-white/40">About<textarea value={values.about} onChange={(event) => setDraft((current) => ({ ...values, ...current, about: event.target.value }))} className={`${inputClass} mt-1 resize-none`} rows={4} maxLength={500} /></label>
          <label className="block text-[13px] text-white/40">Picture URL<input type="url" value={values.picture} onChange={(event) => setDraft((current) => ({ ...values, ...current, picture: event.target.value }))} className={`${inputClass} mt-1`} maxLength={2048} /></label>
        </div>
        {message && <p role="status" className="mt-4 text-sm text-white/60">{message}</p>}
        <button type="submit" disabled={saving} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
          {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} {saving ? 'Publishing…' : 'Publish profile'}
        </button>
      </form>
    </div>
  );
}
