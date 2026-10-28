import React, { useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { MIN_EXISTING_PIN_LENGTH } from '../../lib/vaultLockout';

// Restore — handle + PIN, the by-relay recovery (§10).
export default function Restore({ identity, go }) {
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    const cleanHandle = handle.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
    if (cleanHandle.length < 3) { setError('Handle must be at least 3 letters/numbers'); setLoading(false); return; }
    if (pin.length < MIN_EXISTING_PIN_LENGTH) {
      setError(`PIN must be at least ${MIN_EXISTING_PIN_LENGTH} digits`);
      setLoading(false);
      return;
    }
    try {
      const res = await identity.restoreFromRelays(cleanHandle, pin);
      if (!res.success) setError(res.error);
    } catch (err) {
      setError(err?.message || 'Something went wrong');
    }
    setLoading(false);
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Restore Account</h1>
      <p className="mb-8 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Enter your handle and PIN.</p>

      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4 rounded-3xl border border-line bg-panel p-6">
        <Input type="text" aria-label="Handle" placeholder="yourhandle" value={handle} onChange={(e) => { setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setError(''); }} />
        <Input type="password" aria-label="PIN" placeholder={`PIN (${MIN_EXISTING_PIN_LENGTH}+ digits)`} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} maxLength={8} />
        {error && <p className="text-center text-sm font-medium text-danger">{error}</p>}
        <Button type="submit" disabled={loading} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Continue'}
        </Button>
      </form>

      <div className="mt-8 flex flex-col items-center gap-4">
        <button type="button" onClick={() => go('restore_mnemonic')} className="flex items-center gap-1 text-sm font-medium text-inkMuted transition-colors hover:text-ink">
          <KeyRound size={14} aria-hidden="true" /> Use Recovery Phrase
        </button>
        <button type="button" onClick={() => go('create')} className="text-sm font-medium text-inkMuted transition-colors hover:text-ink">
          Create a new account instead
        </button>
      </div>
    </>
  );
}
