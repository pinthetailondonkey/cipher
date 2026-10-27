import { useState } from 'react';
import { Check, KeyRound, Plus, Trash2 } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';
import { shortNpub } from '../../lib/npub';

export default function AccountSwitcher({ identity, onClose }) {
  const [pins, setPins] = useState({});
  const [pending, setPending] = useState('');
  const [confirmRemove, setConfirmRemove] = useState('');
  const [error, setError] = useState('');
  // Read on every render: a fifth wrong PIN removes that account from the list.
  const accounts = identity?.getAccounts?.() || [];

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

  const handleRemove = async (account) => {
    if (confirmRemove === account.pubkey) {
      setConfirmRemove('');
      setError('');
      const result = await identity.removeAccount?.(account.pubkey);
      if (result && !result.success) setError(result.error || 'Unable to remove the account.');
      return;
    }
    setConfirmRemove(account.pubkey);
  };

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-24 md:pb-4">
      <ScreenHeader title="Accounts" onBack={onClose} />
      <div className="space-y-3 p-4">
      {accounts.map((account) => {
        const name = account.displayName || account.handle || 'Account';
        return (
          <div key={account.pubkey} className="overflow-hidden rounded-2xl border border-line bg-panel p-4">
            <div className="flex items-center gap-3">
              <Avatar name={name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-ink">{name}</span>
                <span className="block truncate text-[13px] text-ink/40">{account.handle ? `@${account.handle}` : shortNpub(account.pubkey)}</span>
              </span>
              {account.isActive ? <Check size={18} className="text-accentText" /> : null}
            </div>
            {!account.isActive && (
              <div className="mt-3 flex gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-line bg-panelStrong px-3">
                  <KeyRound size={16} className="shrink-0 text-ink/40" />
                  <input type="password" inputMode="numeric" autoComplete="current-password" value={pins[account.pubkey] || ''} onChange={(event) => setPins((current) => ({ ...current, [account.pubkey]: event.target.value }))} placeholder="PIN" className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-ink outline-none placeholder:text-ink/30" />
                </label>
                <button type="button" disabled={pending === account.pubkey} onClick={() => handleSwitch(account)} className={`rounded-2xl bg-accent px-4 font-bold text-accentInk active:bg-accent ${pressable}`}>{pending === account.pubkey ? '…' : 'Switch'}</button>
                <button type="button" aria-label="Remove account" onClick={() => handleRemove(account)} className={`flex min-h-11 min-w-11 items-center justify-center rounded-2xl border border-line text-danger active:bg-ink/10 ${pressable}`}>
                  {confirmRemove === account.pubkey ? <span className="text-[12px] font-bold">Sure?</span> : <Trash2 size={16} />}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {accounts.length === 0 && <p className="rounded-2xl border border-line bg-panel px-4 py-10 text-center text-[13px] text-ink/40">No saved accounts on this device.</p>}
      <button type="button" onClick={identity?.addNewAccount} className={`flex w-full items-center justify-center gap-2 rounded-2xl border border-line bg-ink/5 px-4 py-3 font-semibold text-ink active:bg-ink/10 ${pressable}`}>
        <Plus size={18} className="text-accentText" />
        Add account
      </button>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
