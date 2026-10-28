import React, { useEffect, useState } from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { MIN_PIN_LENGTH } from '../../lib/vaultLockout';
import { DEVICE_UNAVAILABLE_COPY, deviceLockReady } from '../../lib/deviceProvider';

// RestoreMnemonic — the 12-word recovery (§10).
export default function RestoreMnemonic({ identity, go }) {
  const [mnemonic, setMnemonic] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // The words are the last thing worth typing on a device that cannot keep
  // them locked, so the check runs before the field is used, not after.
  const [deviceReady, setDeviceReady] = useState(true);
  useEffect(() => {
    let live = true;
    deviceLockReady().then((ready) => { if (live) setDeviceReady(ready); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    if (pin.length < MIN_PIN_LENGTH) {
      setError(`PIN must be at least ${MIN_PIN_LENGTH} digits`);
      setLoading(false);
      return;
    }
    if (!mnemonic.trim() || mnemonic.trim().split(/\s+/).length < 12) {
      setError('Please enter your full 12-word phrase');
    } else {
      try {
        const res = await identity.restoreFromMnemonic(mnemonic, pin);
        if (!res.success) setError(res.error);
      } catch (err) {
        setError(err?.message || 'Something went wrong');
      }
    }
    setLoading(false);
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Restore with Recovery Phrase</h1>
      <p className="mb-8 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Enter your 12-word phrase and a new PIN ({MIN_PIN_LENGTH}+ digits).</p>

      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4 rounded-3xl border border-line bg-panel p-6">
        <textarea placeholder="apple banana cherry ..." value={mnemonic} onChange={(e) => { setMnemonic(e.target.value); setError(''); }} className="w-full resize-none rounded-2xl border border-line bg-panelStrong p-5 text-[15px] text-ink placeholder:text-inkSubtle focus:border-accent focus:outline-none" autoCapitalize="none" autoCorrect="off" spellCheck="false" rows={4} />
        <Input type="password" placeholder={`New PIN (${MIN_PIN_LENGTH}+ digits)`} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} maxLength={8} />
        {error && <p className="text-center text-sm font-medium text-danger">{error}</p>}
        {!deviceReady && <p className="text-center text-[13px] leading-relaxed text-inkMuted">{DEVICE_UNAVAILABLE_COPY}</p>}
        <Button type="submit" disabled={loading || !deviceReady} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Continue'}
        </Button>
      </form>

      <div className="mt-8 flex flex-col items-center gap-4">
        <button type="button" onClick={() => go('restore')} className="flex items-center gap-1 text-sm font-medium text-inkMuted transition-colors hover:text-ink">
          <ChevronLeft size={14} aria-hidden="true" /> Back to handle restore
        </button>
      </div>
    </>
  );
}
