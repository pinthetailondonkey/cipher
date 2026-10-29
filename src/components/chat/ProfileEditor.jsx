import { useState } from 'react';
import { useProfiles, updateProfileCache } from '../../useProfiles';
import { useChatStore } from '../../store/chatStore';
import { getPrivacy } from '../../lib/privacy';
import { AtSign, Image, Type, User } from 'lucide-react';

import { profileEditorRelays } from '../../lib/relays';
import { publishVendorCard, vendorCardContent } from '../../lib/vendorCard';

// The sheet it lives in draws the heading and the dismiss control, so this
// file is the fields and the publish action, nothing else.
export default function ProfileEditor({ identity }) {
  const profiles = useProfiles([identity?.pk]);
  const profile = profiles[identity?.pk] || {};
  const [draft, setDraft] = useState(null);
  const values = draft || {
    name: profile.name || '',
    displayName: profile.displayName || profile.name || '',
    about: profile.about || '',
    picture: profile.picture || '',
  };
  const isVendor = useChatStore((state) => state.isVendor);
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
        content: JSON.stringify(vendorCardContent({
          name: values.name.trim(),
          display_name: values.displayName.trim(),
          about: values.about.trim(),
          picture: getPrivacy().profilePhoto === 'nobody' ? '' : values.picture.trim(),
        })),
      }, identity.sk);
      const results = await Promise.allSettled(pool.publish(profileEditorRelays, nostrEvent));
      const published = results.some((result) => result.status === 'fulfilled');
      if (!published) throw new Error('No relay accepted the profile update.');
      const updated = {
        name: values.name.trim(),
        displayName: values.displayName.trim(),
        about: values.about.trim(),
        picture: values.picture.trim() || null,
      };
      updateProfileCache(identity.pk, updated);
      // A vendor's card also lands on the group relay, because that is the
      // only relay a stranger opening the menu has. The event just signed is
      // the one published, so the card is one event on both relays.
      const card = await publishVendorCard({ isVendor, identity, event: nostrEvent });
      setMessage(isVendor && !card.published
        ? 'Profile saved. Your card could not be published to the group relay.'
        : 'Profile published.');
    } catch (error) {
      console.error('[ProfileEditor] Profile publish failed:', error);
      const text = error?.message || 'Could not save your profile.';
      setMessage(text);
      useChatStore.getState().setToast({ type: 'error', message: text });
    } finally {
      pool?.close(profileEditorRelays);
      setSaving(false);
    }
  };

  const set = (key) => (event) => setDraft((current) => ({ ...values, ...current, [key]: event.target.value }));
  const field = 'w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-inkSubtle';

  return (
    <div className="pb-2">
      <form onSubmit={publishProfile} className="space-y-4">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            <label className="flex items-center gap-3 border-b border-line p-4">
              <AtSign size={24} className="shrink-0 text-inkSubtle" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-inkSubtle">Username</span>
                <input value={values.name} onChange={set('name')} className={field} maxLength={64} />
              </span>
            </label>
            <label className="flex items-center gap-3 border-b border-line p-4">
              <User size={24} className="shrink-0 text-inkSubtle" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-inkSubtle">Display name</span>
                <input value={values.displayName} onChange={set('displayName')} className={field} maxLength={64} />
              </span>
            </label>
            <label className="flex items-start gap-3 border-b border-line p-4">
              <Type size={24} className="mt-1 shrink-0 text-inkSubtle" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-inkSubtle">About</span>
                <textarea value={values.about} onChange={set('about')} className={`${field} resize-none`} rows={3} maxLength={500} />
              </span>
            </label>
            <label className="flex items-center gap-3 p-4">
              <Image size={24} className="shrink-0 text-inkSubtle" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-inkSubtle">Picture URL</span>
                <input type="url" value={values.picture} onChange={set('picture')} className={field} maxLength={2048} placeholder="https://" />
              </span>
            </label>
          </div>
          {isVendor && (
            <p className="text-[13px] text-inkSubtle">
              Selling puts this card on the group relay, where anyone reading your menu can see it.
              That relay can delete its data at any time, so the card is a sign, not a record.
            </p>
          )}
          {message && <p role="status" className={`text-[13px] ${/could not|unlock|error|no relay/i.test(message) ? 'text-danger' : 'text-accentText'}`}>{message}</p>}
          <button type="submit" disabled={saving} className="w-full rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent active:scale-95 disabled:opacity-50">
            {saving ? 'Publishing…' : 'Publish profile'}
          </button>
        </div>
      </form>
    </div>
  );
}
