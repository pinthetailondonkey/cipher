import React, { useState } from 'react';
import { AtSign, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Avatar from '../ui/Avatar';
import { useChatStore } from '../../store/chatStore';
// N1: the onboarding avatar takes the private-media door like every other
// photo — the identity-keyed Blossom auth here let the media host log
// npub-to-IP at account birth, before the person could ever opt out.
import { uploadAttachment, photoRefusalToast } from '../../lib/mediaCrypto';
import { blossomServers } from '../../lib/egress';

// SetupProfile — the last rung of create (§10). The Blossom upload path and
// the finalizeLogin call below are the existing ones, word for word; only
// the skin moved.
export default function SetupProfile({ identity, tempIdentity, initialHandle }) {
  const [username, setUsername] = useState(initialHandle || '');
  const [displayName, setDisplayName] = useState(initialHandle || '');
  const [avatar, setAvatar] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !tempIdentity) return;
    setUploadingAvatar(true);
    try {
      // N1: compress, encrypt, upload under a per-server throwaway key.
      setAvatar(await uploadAttachment(file, blossomServers()));
    } catch (err) {
      useChatStore.getState().setToast({ type: 'info', message: 'Upload failed: ' + photoRefusalToast(err.message) });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleFinishSetup = async (e) => {
    e.preventDefault();
    const clean = username.replace('@', '').trim().toLowerCase();
    if (clean.length < 3) { setError('Username must be 3+ characters'); return; }
    if (!/^[a-z0-9_]+$/.test(clean)) { setError('Only letters, numbers, underscores'); return; }
    setLoading(true);
    setError('');

    localStorage.setItem('cipher_new_account', 'true');
    await identity.finalizeLogin(tempIdentity.sk, tempIdentity.pk, tempIdentity.npub, {
      username: clean,
      displayName: displayName.trim() || clean,
      picture: avatar
    });
    setLoading(false);
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Your Profile</h1>
      <p className="mb-5 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Set up your profile and start messaging.</p>

      <form onSubmit={handleFinishSetup} className="flex w-full flex-col gap-4 rounded-3xl border border-line bg-panel p-6">
        <div className="group relative mx-auto mb-4 cursor-pointer">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-ink/20 bg-ink/5 transition-all group-hover:border-accent">
            <Avatar src={avatar} name="" size="lg" className="h-full w-full object-cover !rounded-none" />
          </div>
          <input type="file" accept="image/*" onChange={handleAvatarUpload} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Choose profile photo" />
          {uploadingAvatar && <div className="absolute inset-0 flex items-center justify-center rounded-full bg-scrim/60"><RefreshCw size={20} className="animate-spin text-ink" aria-hidden="true" /></div>}
        </div>

        <Input type="text" placeholder="Display Name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />

        <div className="relative w-full">
          <AtSign size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-inkMuted" aria-hidden="true" />
          <Input type="text" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} className="pl-11" />
        </div>
        {error && <p className="text-center text-sm font-medium text-danger">{error}</p>}
        <Button type="submit" disabled={loading} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Finish Setup'}
        </Button>
      </form>
    </>
  );
}
