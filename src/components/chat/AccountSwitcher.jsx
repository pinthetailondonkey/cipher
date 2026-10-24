import { useMemo, useState } from 'react';
import { Check, KeyRound } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';

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
    <div className="h-full overflow-y-auto bg-black pb-24">
      <ScreenHeader title="Accounts" onBack={onClose} />
      <div className="space-y-3 p-4">
      {accounts.map((account) => {
        const name = account.displayName || account.handle || 'Account';
        return (
          <div key={account.pubkey} className="overflow-hidden rounded-2xl border border-white/10 bg-[#111] p-4">
            <div className="flex items-center gap-3">
              <Avatar name={name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-white">{name}</span>
                <span className="block truncate text-[13px] text-white/40">@{account.handle || account.pubkey.slice(0, 10)}</span>
              </span>
              {account.isActive ? <Check size={18} className="text-blue-500" /> : null}
            </div>
            {!account.isActive && (
              <div className="mt-3 flex gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-white/10 bg-black px-3">
                  <KeyRound size={16} className="shrink-0 text-white/40" />
                  <input type="password" inputMode="numeric" autoComplete="current-password" value={pins[account.pubkey] || ''} onChange={(event) => setPins((current) => ({ ...current, [account.pubkey]: event.target.value }))} placeholder="PIN" className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
                </label>
                <button type="button" disabled={pending === account.pubkey} onClick={() => handleSwitch(account)} className={`rounded-2xl bg-blue-600 px-4 font-bold text-white active:bg-blue-700 ${pressable}`}>{pending === account.pubkey ? '…' : 'Switch'}</button>
              </div>
            )}
          </div>
        );
      })}
      {accounts.length === 0 && <p className="rounded-2xl border border-white/10 bg-[#111] px-4 py-10 text-center text-[13px] text-white/40">No saved accounts on this device.</p>}
      {error && <p role="alert" className="text-[13px] text-red-400">{error}</p>}
      </div>
    </div>
  );
}
