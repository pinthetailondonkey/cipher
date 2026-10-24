import { useMemo, useState } from 'react';
import { ArrowLeft, Check, KeyRound, User } from 'lucide-react';
import Button, { pressable } from '../ui/Button';
import Card from '../ui/Card';

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
      <button type="button" onClick={onClose} className={`flex items-center gap-1 px-4 pb-2 pt-4 text-[13px] text-white/40 ${pressable}`} aria-label="Back"><ArrowLeft size={16} /> Back</button>
      <h2 className="px-4 pb-4 text-2xl font-bold tracking-tight text-white">Accounts</h2>
      <div className="mx-4 space-y-3">
        {accounts.map((account) => (
          <Card key={account.pubkey} className="rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-black text-blue-500"><User size={20} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-white">{account.displayName || account.handle || 'Account'}</span>
                <span className="block truncate text-[13px] text-white/40">@{account.handle || account.pubkey.slice(0, 10)}</span>
              </span>
              {account.isActive ? <Check size={20} className="text-blue-500" /> : null}
            </div>
            {!account.isActive && (
              <div className="mt-3 flex gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-white/10 bg-black px-3">
                  <KeyRound size={16} className="shrink-0 text-white/40" />
                  <input type="password" inputMode="numeric" autoComplete="current-password" value={pins[account.pubkey] || ''} onChange={(event) => setPins((current) => ({ ...current, [account.pubkey]: event.target.value }))} placeholder="Account PIN" className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-white outline-none placeholder:text-white/30" />
                </label>
                <Button disabled={pending === account.pubkey} onClick={() => handleSwitch(account)} className="px-4">{pending === account.pubkey ? '…' : 'Switch'}</Button>
              </div>
            )}
          </Card>
        ))}
        {accounts.length === 0 && <p className="py-6 text-center text-[13px] text-white/40">No saved accounts on this device.</p>}
        {error && <p role="alert" className="text-[13px] text-red-400">{error}</p>}
      </div>
    </div>
  );
}
