import { useState } from 'react';
import { copyText } from '../../lib/copyText';
import { Copy, Download, Fingerprint, KeyRound, Shield } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { pressable } from '../ui/Button';
import { shortNpub } from '../../lib/npub';

export default function IdentityBackup({ identity, onClose }) {
  const [showSecret, setShowSecret] = useState(false);
  const [secretKey, setSecretKey] = useState('');
  const [copied, setCopied] = useState('');
  const [exportReady, setExportReady] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [enablingBiometric, setEnablingBiometric] = useState(false);
  const [biometricMessage, setBiometricMessage] = useState('');
  const npub = identity?.npub || '';

  const getSecretKey = async () => {
    if (!identity?.sk) return '';
    const { nip19 } = await import('nostr-tools');
    return nip19.nsecEncode(identity.sk);
  };

  const copy = async (label, value) => {
    const copyValue = label === 'nsec' ? await getSecretKey() : value;
    const ok = await copyText(copyValue);
    if (ok) {
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    }
  };

  const toggleSecret = async () => {
    if (showSecret) {
      setShowSecret(false);
      return;
    }
    try {
      setSecretKey(await getSecretKey());
      setShowSecret(true);
    } catch (error) {
      console.error('[IdentityBackup] Failed to encode secret key:', error);
      setCopied('Secret key unavailable');
    }
  };

  const copyPhrase = async () => {
    try {
      const mnemonic = await identity?.getMnemonic?.();
      if (!mnemonic) throw new Error('This account has no recovery phrase saved on this device.');
      const ok = await copyText(mnemonic);
      if (!ok) return;
      setCopied('phrase');
      window.setTimeout(() => setCopied(''), 1800);
    } catch (error) {
      console.error('[IdentityBackup] Could not copy recovery phrase:', error);
      setCopied(error?.message || 'Could not copy the recovery phrase.');
    }
  };

  const downloadRecoveryFile = async () => {
    if (!identity?.sk || exporting) return;
    if (!exportReady) {
      setCopied('Confirm that you understand this file contains your secret key.');
      return;
    }
    setExporting(true);
    try {
      const mnemonic = await identity.getMnemonic();
      if (!mnemonic) throw new Error('This account has no locally available recovery phrase. Use the phrase you saved when creating or restoring the account.');
      const nsec = await getSecretKey();
      const handle = localStorage.getItem('cipher_handle') || 'Cipher account';
      const contents = [
        'CIPHER ACCOUNT RECOVERY BACKUP',
        'Keep this file private. Anyone with these credentials can control your account.',
        '',
        `Account: ${handle}`,
        `Public key (npub): ${npub}`,
        `Secret key (nsec): ${nsec}`,
        '',
        '12-word recovery phrase:',
        mnemonic,
        '',
        'To restore: choose “Restore with 12-word recovery phrase” and enter the phrase above.',
      ].join('\n');
      const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cipher-recovery-${shortNpub(identity.pk, 12)}.txt`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setCopied('Recovery file downloaded. Keep it private.');
    } catch (error) {
      console.error('[IdentityBackup] Recovery export failed:', error);
      setCopied(error?.message || 'Could not export recovery file.');
    } finally {
      setExporting(false);
    }
  };

  const setupBiometric = async () => {
    if (!identity?.enableBiometric || enablingBiometric) return;
    setEnablingBiometric(true);
    setBiometricMessage('');
    try {
      const result = await identity.enableBiometric();
      setBiometricMessage(result.success ? 'Face ID / device passkey is ready for future unlocks.' : (result.error || 'Could not set up this device passkey.'));
    } finally {
      setEnablingBiometric(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-8">
      <ScreenHeader title="Backup" onBack={onClose} />
      <div className="space-y-4 p-4">
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-white/5 p-4 text-[13px] text-amber-200">
          <Shield size={18} className="mt-0.5 shrink-0" />
          Your secret key controls this account. Never share it.
        </div>
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          {identity?.hasBiometric ? (
            <p className="flex items-center gap-3 p-4 text-[15px] text-emerald-300"><Fingerprint size={18} /> Face ID is on</p>
          ) : (
            <button type="button" onClick={setupBiometric} disabled={!identity?.sk || enablingBiometric} className={`flex w-full items-center gap-3 p-4 text-left text-[15px] font-semibold text-white disabled:opacity-40 ${pressable}`}>
              <Fingerprint size={18} className="text-white/40" /> {enablingBiometric ? 'Setting up…' : 'Set up Face ID'}
            </button>
          )}
          {biometricMessage && <p role="status" className="border-t border-white/5 px-4 py-3 text-[13px] text-white/40">{biometricMessage}</p>}
        </div>
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          <div className="flex items-center gap-3 border-b border-white/5 p-4">
            <KeyRound size={18} className="shrink-0 text-white/40" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-white/40">Public key</p>
              <p className="truncate font-mono text-[13px] text-white">{npub || 'Not loaded'}</p>
            </div>
            <button type="button" onClick={() => copy('npub', npub)} disabled={!npub} className={`text-[13px] font-semibold text-accent ${pressable}`}>{copied === 'npub' ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="flex items-center gap-3 p-4">
            <KeyRound size={18} className="shrink-0 text-white/40" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-white/40">Secret key</p>
              <p className="truncate font-mono text-[13px] text-white">{showSecret ? secretKey : '••••••••••••••••'}</p>
            </div>
            <button type="button" onClick={toggleSecret} className={`text-[13px] font-semibold text-accent ${pressable}`}>{showSecret ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        <button type="button" onClick={() => copy('nsec')} disabled={!identity?.sk} className={`flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent disabled:opacity-40 ${pressable}`}>
          <Copy size={16} /> {copied === 'nsec' ? 'Copied' : 'Copy secret key'}
        </button>
        <button type="button" onClick={copyPhrase} disabled={!identity?.sk} className={`flex w-full items-center justify-center gap-2 rounded-2xl border border-line bg-panel shadow-lg py-3.5 font-bold text-white disabled:opacity-40 ${pressable}`}>
          <Copy size={16} /> {copied === 'phrase' ? 'Copied' : 'Copy 12-word phrase'}
        </button>
        <label className="flex items-start gap-3 rounded-2xl border border-line bg-panel shadow-lg p-4 text-[13px] text-white/70">
          <input type="checkbox" checked={exportReady} onChange={(event) => setExportReady(event.target.checked)} className="mt-0.5 h-5 w-5 accent-blue-600" />
          I understand this file contains my secret key and 12-word phrase.
        </label>
        <button type="button" onClick={downloadRecoveryFile} disabled={!identity?.sk || exporting || !exportReady} className={`flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent disabled:opacity-40 ${pressable}`}>
          <Download size={16} /> {exporting ? 'Preparing…' : 'Download recovery backup'}
        </button>
        <p className="px-1 text-[13px] text-white/40">Store it privately. Never upload or share it.</p>
        {copied && copied !== 'npub' && copied !== 'nsec' && copied !== 'phrase' && <p role="status" className="text-[13px] text-accent">{copied}</p>}
      </div>
    </div>
  );
}
