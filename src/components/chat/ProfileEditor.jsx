import { useState } from 'react';
import { ArrowLeft, RefreshCw, Save } from 'lucide-react';
import { useProfiles, updateProfileCache } from '../../useProfiles';
import { useChatStore } from '../../store/chatStore';
import { getPrivacy } from '../../lib/privacy';
import Button, { pressable } from '../ui/Button';
import Card from '../ui/Card';

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

  const inputClass = 'mt-1 w-full rounded-2xl border border-white/10 bg-black p-4 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50';

  return (
    <div className="h-full overflow-y-auto bg-black pb-24">
      <form onSubmit={publishProfile}>
        <button type="button" onClick={onClose} className={`flex items-center gap-1 px-4 pb-2 pt-4 text-[13px] text-white/40 ${pressable}`} aria-label="Back"><ArrowLeft size={16} /> Back</button>
        <h2 className="px-4 pb-4 text-2xl font-bold tracking-tight text-white">Edit Profile</h2>
        <Card className="mx-4 space-y-4 rounded-2xl p-4">
          <label className="block text-[13px] text-white/40">Username<input value={values.name} onChange={(event) => setDraft((current) => ({ ...values, ...current, name: event.target.value }))} className={inputClass} maxLength={64} /></label>
          <label className="block text-[13px] text-white/40">Display name<input value={values.displayName} onChange={(event) => setDraft((current) => ({ ...values, ...current, displayName: event.target.value }))} className={inputClass} maxLength={64} /></label>
          <label className="block text-[13px] text-white/40">About<textarea value={values.about} onChange={(event) => setDraft((current) => ({ ...values, ...current, about: event.target.value }))} className={`${inputClass} resize-none`} rows={4} maxLength={500} /></label>
          <label className="block text-[13px] text-white/40">Picture URL<input type="url" value={values.picture} onChange={(event) => setDraft((current) => ({ ...values, ...current, picture: event.target.value }))} className={inputClass} maxLength={2048} /></label>
          {message && <p role="status" className={`text-[13px] ${/could not|unlock|error|no relay/i.test(message) ? 'text-red-400' : 'text-blue-500'}`}>{message}</p>}
          <Button type="submit" disabled={saving} className="flex w-full items-center justify-center gap-2">
            {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} {saving ? 'Publishing…' : 'Publish profile'}
          </Button>
        </Card>
      </form>
    </div>
  );
}
