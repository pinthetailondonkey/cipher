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
      setBiometricMessage(result.success ? 'A saved passkey opens this account on this device from now on. It does not replace the 12 words.' : (result.error || 'Could not set up this device passkey.'));
    } finally {
      setEnablingBiometric(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-transparent pb-[calc(env(safe-area-inset-bottom,0px)+2rem)]">
      <ScreenHeader title="Backup" onBack={onClose} />
      <div className="space-y-4 p-4">
        {/* Recovery leads. The 12 words are the only backup that brings the
            account back on a new device; the passkey and the raw key below
            each open one narrower door, so they sit after it. This screen
            saves the account — it does not save the chats on this device. */}
        <div className="rounded-2xl border border-line bg-panel p-4">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="shrink-0 text-accentText" />
            <p className="text-[15px] font-semibold text-ink">Recovery phrase</p>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-inkMuted">
            The 12 words you wrote down bring this account back on a new device, with a new PIN you choose there. This is the only backup that works on a new phone.
          </p>
          <button type="button" onClick={copyPhrase} disabled={!identity?.sk} className={`mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent disabled:opacity-40 ${pressable}`}>
            <Copy size={16} /> {copied === 'phrase' ? 'Copied' : 'Copy 12-word phrase'}
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          {identity?.hasBiometric ? (
            <p className="flex items-center gap-3 p-4 text-[15px] text-success"><Fingerprint size={24} className="shrink-0" /> A saved passkey opens this account on this device</p>
          ) : (
            <button type="button" onClick={setupBiometric} disabled={!identity?.sk || enablingBiometric} className={`flex w-full items-center gap-3 p-4 text-left text-[15px] font-semibold text-ink disabled:opacity-40 ${pressable}`}>
              <Fingerprint size={24} className="shrink-0 text-inkSubtle" /> {enablingBiometric ? 'Setting up…' : 'Set up a saved passkey'}
            </button>
          )}
          <p className="border-t border-line px-4 py-3 text-[13px] leading-relaxed text-inkMuted">
            It asks this device for whichever unlock it uses: a face, a fingerprint, a PIN or a security key. It opens this device only, and it does not replace the 12 words.
          </p>
          {biometricMessage && <p role="status" className="border-t border-line px-4 py-3 text-[13px] text-inkMuted">{biometricMessage}</p>}
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex items-center gap-3 border-b border-line p-4">
            <KeyRound size={24} className="shrink-0 text-inkSubtle" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-inkSubtle">Public key</p>
              <p className="truncate font-mono text-[13px] text-ink">{npub || 'Not loaded'}</p>
            </div>
            <button type="button" onClick={() => copy('npub', npub)} disabled={!npub} className={`text-[13px] font-semibold text-accentText ${pressable}`}>{copied === 'npub' ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="flex items-center gap-3 p-4">
            <KeyRound size={24} className="shrink-0 text-inkSubtle" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-inkSubtle">Secret key</p>
              <p className="truncate font-mono text-[13px] text-ink">{showSecret ? secretKey : '••••••••••••••••'}</p>
            </div>
            <button type="button" onClick={toggleSecret} className={`text-[13px] font-semibold text-accentText ${pressable}`}>{showSecret ? 'Hide' : 'Show'}</button>
          </div>
        </div>

        <button type="button" onClick={() => copy('nsec')} disabled={!identity?.sk} className={`flex w-full items-center justify-center gap-2 rounded-2xl border border-line bg-panel py-3.5 font-bold text-ink disabled:opacity-40 ${pressable}`}>
          <Copy size={16} /> {copied === 'nsec' ? 'Copied' : 'Copy secret key'}
        </button>

        <div className="rounded-2xl border border-line bg-panel p-4">
          <div className="flex items-start gap-3 text-[13px] text-ink/70">
            <Shield size={20} className="mt-0.5 shrink-0 text-inkSubtle" />
            <p>A file with your secret key and your 12 words. Keep it private and never upload or share it. This backup is your account, not the chats saved on this device.</p>
          </div>
          <label className="mt-3 flex items-start gap-3 text-[13px] text-ink/70">
            <input type="checkbox" checked={exportReady} onChange={(event) => setExportReady(event.target.checked)} className="mt-0.5 h-5 w-5 accent-accent" />
            I understand this file contains my secret key and 12-word phrase.
          </label>
          <button type="button" onClick={downloadRecoveryFile} disabled={!identity?.sk || exporting || !exportReady} className={`mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-line bg-panelStrong py-3.5 font-bold text-ink disabled:opacity-40 ${pressable}`}>
            <Download size={16} /> {exporting ? 'Preparing…' : 'Download recovery backup'}
          </button>
        </div>

        {copied && copied !== 'npub' && copied !== 'nsec' && copied !== 'phrase' && <p role="status" className="text-[13px] text-accentText">{copied}</p>}
      </div>
    </div>
  );
}
