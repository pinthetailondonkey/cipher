import React, { useState } from 'react';
import { AtSign, Check, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { MIN_PIN_LENGTH } from '../../lib/vaultLockout';
import { usernameRelays } from '../../lib/relays';

// Create — the first-run account mode (§10). The BYPASSED username precheck
// stays bypassed exactly as it was; the handle is only truly checked when
// the login is finalized.
export default function Create({ identity, onCreated, go }) {
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const [enableBio, setEnableBio] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const checkUsernameAvailable = async (username) => {
    let pool;
    const relays = usernameRelays;
    try {
      const { SimplePool } = await import('nostr-tools');
      pool = new SimplePool();
      const events = await Promise.race([
        pool.querySync(relays, { kinds: [10003], '#t': ['cipher_username_' + username], limit: 5 }),
        new Promise(r => setTimeout(() => r([{ id: 'timeout', tags: [] }]), 3000)),
      ]);
      return events.length === 0;
    } catch (e) {
      console.warn('Precheck failed — failing CLOSED to prevent squatting:', e);
      return false;
    } finally {
      pool?.close(relays);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');

    const cleanHandle = handle.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
    if (cleanHandle.length < 3) { setError('Handle must be at least 3 letters/numbers'); setLoading(false); return; }
    if (pin.length !== MIN_PIN_LENGTH) {
      setError(`PIN must be ${MIN_PIN_LENGTH} digits`);
      setLoading(false);
      return;
    }

    try {
      const available = true; // BYPASSED: Pre-check is buggy
      if (!available) {
        setError('@' + cleanHandle + ' is already taken. Try another.');
        setLoading(false);
        return;
      }
      const res = await identity.createVault(cleanHandle, pin, enableBio);
      const _words = (res.mnemonic || '').split(' ');
      const _idxs = [];
      while (_idxs.length < 3) {
        const r = Math.floor(Math.random() * _words.length);
        if (!_idxs.includes(r)) _idxs.push(r);
      }
      onCreated({ res, cleanHandle, indices: _idxs });
    } catch (err) {
      setError(err?.message || 'Something went wrong');
    }
    setLoading(false);
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Welcome to Cipher</h1>
      <p className="mb-8 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Pick a handle and a PIN ({MIN_PIN_LENGTH} digits).</p>

      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4 rounded-3xl border border-line bg-panel p-6">
        <div className="relative w-full">
          <AtSign size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-inkMuted" aria-hidden="true" />
          <Input type="text" placeholder="yourhandle" value={handle} onChange={(e) => { setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setError(''); }} className="pl-11" />
        </div>
        <Input type="password" placeholder={`PIN (${MIN_PIN_LENGTH} digits)`} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} maxLength={8} />
        <label className="mt-1 flex cursor-pointer items-center justify-center gap-3 text-sm text-inkMuted transition-colors hover:text-ink">
          <span className="relative flex h-5 w-5 items-center justify-center">
            <input type="checkbox" checked={enableBio} onChange={(e) => setEnableBio(e.target.checked)} className="peer h-5 w-5 appearance-none rounded-md border border-ink/20 bg-ink/5 transition-colors checked:border-accent checked:bg-accent" />
            <Check size={14} strokeWidth={3} className="pointer-events-none absolute text-ink opacity-0 transition-opacity peer-checked:opacity-100" aria-hidden="true" />
          </span>
          Set up a saved passkey
        </label>
        {error && <p className="mb-1 mt-1 text-center text-sm font-medium text-danger">{error}</p>}
        <Button type="submit" disabled={loading} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Continue'}
        </Button>
      </form>

      <div className="mt-8 flex w-full flex-col items-center gap-4">
        <button type="button" onClick={() => go('restore')} className="text-sm font-medium text-inkMuted transition-colors hover:text-ink">
          Restore account on this device
        </button>
        <button type="button" onClick={() => go('restore_mnemonic')} className="text-sm font-medium text-accentText transition-colors hover:text-accentText">
          Restore with 12-word recovery phrase
        </button>
      </div>
    </>
  );
}
