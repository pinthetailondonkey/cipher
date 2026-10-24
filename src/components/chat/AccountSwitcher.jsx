import { useMemo, useState } from 'react';
import { ArrowLeft, Check, KeyRound, User, X } from 'lucide-react';

export default function AccountSwitcher({ identity, onClose }) {
  const accounts = useMemo(() => identity?.getAccounts?.() || [], [identity]);
  const [pins, setPins] = useState({});
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');

  const handleSwitch = async (account) => {
    if (account.isActive) return;
    setPending(account.pubkey);
    setError('');
    try {
      const result = await identity.switchAccount(account.pubkey, pins[account.pubkey] || '');
      if (!result.success) setError(result.error || 'Unable to switch accounts.');
      else onClose();
    } catch (switchError) {
      console.error('[AccountSwitcher] Could not switch accounts:', switchError);
      setError(switchError?.message || 'Unable to switch accounts.');
    } finally {
      setPending('');
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Switch account">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-6">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="p-1 text-white/50 hover:text-white" aria-label="Back"><ArrowLeft size={20} /></button>
            <h2 className="text-xl font-bold text-white">Accounts</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close"><X size={20} /></button>
        </div>
        <div className="-mx-6 max-h-[60vh] overflow-y-auto">
          {accounts.map((account) => (
            <div key={account.pubkey} className="border-b border-white/5 px-6 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111] text-white/60"><User size={20} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">{account.displayName || account.handle || 'Account'}</span>
                  <span className="block truncate text-[13px] text-white/40">@{account.handle || account.pubkey.slice(0, 10)}</span>
                </span>
                {account.isActive ? <Check size={20} className="text-blue-500" /> : null}
              </div>
              {!account.isActive && (
                <div className="mt-3 flex gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-[#111] px-3">
                    <KeyRound size={16} className="shrink-0 text-white/40" />
                    <input type="password" inputMode="numeric" autoComplete="current-password" value={pins[account.pubkey] || ''} onChange={(event) => setPins((current) => ({ ...current, [account.pubkey]: event.target.value }))} placeholder="Account PIN" className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none placeholder:text-white/30" />
                  </label>
                  <button type="button" disabled={pending === account.pubkey} onClick={() => handleSwitch(account)} className="rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">{pending === account.pubkey ? 'Switching…' : 'Switch'}</button>
                </div>
              )}
            </div>
          ))}
        </div>
        {accounts.length === 0 && <p className="py-6 text-center text-sm text-white/40">No saved accounts on this device.</p>}
        {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
