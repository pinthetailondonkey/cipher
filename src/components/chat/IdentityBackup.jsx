import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Copy, Download, Eye, EyeOff } from 'lucide-react';
import { copyText } from '../../lib/copyText';
import Button, { pressable } from '../ui/Button';
import Card from '../ui/Card';

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
      link.download = `cipher-recovery-${identity.pk.slice(0, 8)}.txt`;
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
    <div className="h-full overflow-y-auto bg-black pb-24">
      <button type="button" onClick={onClose} className={`flex items-center gap-1 px-4 pb-2 pt-4 text-[13px] text-white/40 ${pressable}`} aria-label="Back"><ArrowLeft size={16} /> Back</button>
      <h2 className="px-4 pb-4 text-2xl font-bold tracking-tight text-white">Identity Backup</h2>
      <div className="mx-4 space-y-3">
        <Card className="flex gap-3 rounded-2xl p-4 text-amber-200/80">
          <AlertTriangle size={20} className="shrink-0" />
          <p className="text-[13px]">Your secret key controls this account. Never share it with anyone.</p>
        </Card>
        {identity?.hasBiometric ? (
          <Card className="rounded-2xl px-4 py-3 text-[13px] text-emerald-300">Face ID / device passkey is enabled for this account.</Card>
        ) : (
          <Button variant="secondary" onClick={setupBiometric} disabled={!identity?.sk || enablingBiometric} className="w-full">
            {enablingBiometric ? 'Setting up device passkey…' : 'Set up Face ID / device passkey'}
          </Button>
        )}
        {biometricMessage && <p role="status" className="text-center text-[13px] text-white/40">{biometricMessage}</p>}
        <Card className="rounded-2xl p-4">
          <p className="mb-2 text-[13px] text-white/40">Public key</p>
          <div className="flex gap-2">
            <input readOnly value={npub} className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-black p-4 font-mono text-[13px] text-white" />
            <button type="button" onClick={() => copy('npub', npub)} disabled={!npub} className={`rounded-2xl border border-white/10 bg-black px-3 text-blue-500 disabled:opacity-40 ${pressable}`} aria-label="Copy public key"><Copy size={17} /></button>
          </div>
        </Card>
        <Card className="rounded-2xl p-4">
          <p className="mb-2 text-[13px] text-white/40">Secret key</p>
          <div className="mb-3 flex gap-2">
            <input readOnly type={showSecret ? 'text' : 'password'} value={secretKey} className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-black p-4 font-mono text-[13px] text-white" />
            <button type="button" onClick={toggleSecret} className={`rounded-2xl border border-white/10 bg-black px-3 text-white/60 ${pressable}`} aria-label={showSecret ? 'Hide secret key' : 'Reveal secret key'}>{showSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            <button type="button" onClick={() => copy('nsec')} disabled={!identity?.sk} className={`rounded-2xl border border-white/10 bg-black px-3 text-blue-500 disabled:opacity-40 ${pressable}`} aria-label="Copy secret key"><Copy size={17} /></button>
          </div>
          <Button variant="secondary" onClick={() => copy('nsec')} disabled={!identity?.sk} className="mb-3 flex w-full items-center justify-center gap-2">
            <Copy size={16} /> {copied === 'nsec' ? 'Copied!' : 'Copy secret key'}
          </Button>
          <Button onClick={copyPhrase} disabled={!identity?.sk} className="flex w-full items-center justify-center gap-2">
            <Copy size={16} /> {copied === 'phrase' ? 'Copied!' : 'Copy 12-word phrase'}
          </Button>
        </Card>
        <Card className="rounded-2xl p-4">
          <label className="mb-3 flex items-start gap-3 text-[13px] text-white/70">
            <input type="checkbox" checked={exportReady} onChange={(event) => setExportReady(event.target.checked)} className="mt-0.5 h-5 w-5 rounded border-white/20 bg-black accent-blue-600" />
            I understand this file contains my secret key and 12-word phrase.
          </label>
          <Button variant="secondary" onClick={downloadRecoveryFile} disabled={!identity?.sk || exporting || !exportReady} className="flex w-full items-center justify-center gap-2">
            <Download size={17} /> {exporting ? 'Preparing recovery file…' : 'Download recovery backup'}
          </Button>
          <p className="mt-2 text-center text-[13px] text-white/40">Store it privately. Never upload or share it.</p>
        </Card>
        {copied && copied !== 'npub' && copied !== 'nsec' && copied !== 'phrase' && <p role="status" className="text-center text-[13px] text-blue-500">{copied}</p>}
      </div>
    </div>
  );
}
