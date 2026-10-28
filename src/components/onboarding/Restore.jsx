import React, { useEffect, useState } from 'react';
import { Fingerprint, KeyRound, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { MIN_EXISTING_PIN_LENGTH } from '../../lib/vaultLockout';
import { canOpenWithPasskey } from '../../lib/passkeyRecord';
import { PASSKEY_FAILED, passkeyFailureMessage } from '../../lib/passkeyMessages';

// Restore — handle + PIN, the by-relay recovery (§10). A saved passkey
// record opens a second door on this device; the 12 words remain the only
// one that works on a new device.
export default function Restore({ identity, go }) {
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // The door asks the same two questions the unlock will: a record for this
  // account, and a device that can answer a PRF request. Offering it on the
  // record alone promised an unlock that could never succeed.
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const { isPRFSupported } = await import('nostr-passkey');
      const open = await canOpenWithPasskey(localStorage, isPRFSupported);
      if (live) setCanUsePasskey(open);
    })().catch(() => { /* no support check, no door */ });
    return () => { live = false; };
  }, []);

  const handleBiometricRecover = async () => {
    if (loading) return;
    setLoading(true); setError('');
    try {
      const res = await identity.unlockWithBiometric(pin);
      // Cancelled, unavailable or refused: a plain sentence, never the
      // authenticator's or the browser's own words.
      if (!res.success) setError(passkeyFailureMessage(res));
    } catch (err) {
      console.error('[Restore] Passkey recovery failed:', err);
      setError(PASSKEY_FAILED);
    } finally {
      // Every outcome puts the screen back, including a throw.
      setLoading(false);
    }
  };

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
        <Input type="text" placeholder="yourhandle" value={handle} onChange={(e) => { setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setError(''); }} />
        <Input type="password" placeholder={`PIN (${MIN_EXISTING_PIN_LENGTH}+ digits)`} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} maxLength={8} />
        {error && <p className="text-center text-sm font-medium text-danger">{error}</p>}
        <Button type="submit" disabled={loading} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Continue'}
        </Button>
      </form>

      <div className="mt-8 flex flex-col items-center gap-4">
        {canUsePasskey && (
          <button type="button" onClick={handleBiometricRecover} disabled={loading} className="flex items-center gap-1 text-sm font-medium text-inkMuted transition-colors hover:text-ink disabled:opacity-50">
            <Fingerprint size={14} aria-hidden="true" /> Use saved passkey
          </button>
        )}
        <button type="button" onClick={() => go('restore_mnemonic')} className="flex items-center gap-1 text-sm font-medium text-inkMuted transition-colors hover:text-ink">
          <KeyRound size={14} aria-hidden="true" /> Use Recovery Phrase
        </button>
        <button type="button" onClick={() => go('create')} className="text-sm font-medium text-inkMuted transition-colors hover:text-ink">
          Create a new account instead
        </button>
      </div>
      {canUsePasskey && (
        <p className="mt-4 max-w-[280px] text-center text-xs leading-relaxed text-inkMuted">A saved passkey opens this account on this device. Your 12 words bring it back on a new one.</p>
      )}
    </>
  );
}
