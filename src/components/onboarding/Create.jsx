import React, { useEffect, useState } from 'react';
import { AtSign, Check, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { MIN_PIN_LENGTH } from '../../lib/vaultLockout';
import { usernameRelays } from '../../lib/relays';
import { querySyncAfterAuth } from '../../lib/pool';
import { HANDLE_TAKEN, lookupHandleClaim } from '../../lib/handleClaim';
import { DEVICE_UNAVAILABLE_COPY, deviceLockReady } from '../../lib/deviceProvider';

// Create — the first-run account mode (§10). The handle is checked against the
// pubkey it will be published to before anything is made, and that check can
// return three answers, not two: available, taken, or unknown. Unknown allows
// the signup on purpose — what it costs and why is written out in
// lib/handleClaim.js. This screen only decides what to do with each answer.
export default function Create({ identity, onCreated, go }) {
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const [enableBio, setEnableBio] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Asked before anything is typed, and long before any words are shown: a
  // device that cannot hold a key cannot make an account, and the screen says
  // so instead of failing at the end.
  const [deviceReady, setDeviceReady] = useState(true);
  useEffect(() => {
    let live = true;
    deviceLockReady().then((ready) => { if (live) setDeviceReady(ready); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // The relays are read through the codebase's own AUTH-aware reader rather
  // than pool.querySync: a relay that challenges AUTH answers the first REQ
  // with EOSE and then leaves it alone, so a direct query can come back empty
  // and an empty read is what "available" is made of. At first run there is no
  // key yet, so no challenge can be answered — that residual is named in
  // lib/handleClaim.js and in the lane report rather than hidden here.
  const readClaims = async (filter, timeoutMs) => {
    const { SimplePool } = await import('nostr-tools');
    const pool = new SimplePool();
    try {
      // Half the budget for the AUTH re-ask, so the deadline above it is the
      // one that decides, not this one racing it.
      return await querySyncAfterAuth(pool, usernameRelays, filter, Math.max(500, Math.floor(timeoutMs / 2)));
    } finally {
      pool.close(usernameRelays);
    }
  };

  const checkUsernameAvailable = async (username) => (
    lookupHandleClaim({ read: readClaims, username })
  );

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
      // taken refuses and says so; available and unknown both go on. Unknown
      // is not a silent pass by accident — it is the written decision in
      // lib/handleClaim.js, and the screen cannot tell the person it was not
      // checked without a second screen nobody asked for.
      const verdict = await checkUsernameAvailable(cleanHandle);
      if (verdict === HANDLE_TAKEN) {
        setError('@' + cleanHandle + ' is taken. Try another.');
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
    } finally {
      // Every way out of this — a refusal, a throw from the vault, anything —
      // has to unlock the button. A refusal that leaves the submit dead is the
      // same defect as a refusal that never comes: the person cannot try
      // another handle.
      setLoading(false);
    }
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Welcome to Cipher</h1>
      <p className="mb-5 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Pick a handle and a PIN ({MIN_PIN_LENGTH} digits).</p>

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
        {!deviceReady && <p className="text-center text-[13px] leading-relaxed text-inkMuted">{DEVICE_UNAVAILABLE_COPY}</p>}
        <Button type="submit" disabled={loading || !deviceReady} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Continue'}
        </Button>
      </form>

      <div className="mt-6 flex w-full flex-col items-center gap-4">
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
