import { useState } from 'react';
import { AlertTriangle, Copy, Download, Eye, EyeOff, X } from 'lucide-react';

export default function IdentityBackup({ identity, onClose }) {
  const [showSecret, setShowSecret] = useState(false);
  const [secretKey, setSecretKey] = useState('');
  const [copied, setCopied] = useState('');
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
    try {
      const copyValue = label === 'nsec' ? await getSecretKey() : value;
      await navigator.clipboard.writeText(copyValue);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    } catch (error) {
      console.error('[IdentityBackup] Clipboard copy failed:', error);
      setCopied('Copy failed');
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

  const downloadRecoveryFile = async () => {
    if (!identity?.sk || exporting) return;
    if (!window.confirm('This file contains your secret key and 12-word recovery phrase. Anyone with the file can control your account. Save it somewhere private and never share it. Continue?')) return;
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
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Identity backup">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">Identity Backup</h2>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close"><X size={20} /></button>
        </div>
        <div className="mb-5 flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-amber-200/80">
          <AlertTriangle size={20} className="shrink-0" />
          <p className="text-[13px]">Your secret key controls this account. Never share it with anyone.</p>
        </div>
        {identity?.hasBiometric ? (
          <p className="mb-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-300">Face ID / device passkey is enabled for this account.</p>
        ) : (
          <button type="button" onClick={setupBiometric} disabled={!identity?.sk || enablingBiometric} className="mb-5 flex min-h-12 w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white/80 hover:bg-white/10 disabled:opacity-50">
            {enablingBiometric ? 'Setting up device passkey…' : 'Set up Face ID / device passkey'}
          </button>
        )}
        {biometricMessage && <p role="status" className="mb-4 text-center text-sm text-white/60">{biometricMessage}</p>}
        <label className="mb-4 block text-[13px] text-white/40">Public key (npub)</label>
        <div className="-mt-2 mb-5 flex gap-2">
          <input readOnly value={npub} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111] px-3 py-3 font-mono text-xs text-white/80" />
          <button type="button" onClick={() => copy('npub', npub)} disabled={!npub} className="rounded-xl border border-white/10 px-3 text-white/60 hover:text-white disabled:opacity-40" aria-label="Copy public key"><Copy size={17} /></button>
        </div>
        <label className="mb-2 block text-[13px] text-white/40">Secret key (nsec)</label>
        <div className="mb-2 flex gap-2">
          <input readOnly type={showSecret ? 'text' : 'password'} value={secretKey} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111] px-3 py-3 font-mono text-xs text-white/80" />
          <button type="button" onClick={toggleSecret} className="rounded-xl border border-white/10 px-3 text-white/60 hover:text-white" aria-label={showSecret ? 'Hide secret key' : 'Reveal secret key'}>{showSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          <button type="button" onClick={() => copy('nsec', secretKey)} disabled={!identity?.sk} className="rounded-xl border border-white/10 px-3 text-white/60 hover:text-white disabled:opacity-40" aria-label="Copy secret key"><Copy size={17} /></button>
        </div>
        <button type="button" onClick={downloadRecoveryFile} disabled={!identity?.sk || exporting} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 text-sm font-semibold text-blue-300 hover:bg-blue-500/15 disabled:opacity-50">
          <Download size={17} /> {exporting ? 'Preparing recovery file…' : 'Download recovery backup (.txt)'}
        </button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-amber-200/55">Includes your secret key and recovery phrase. Store securely; never upload or share it.</p>
        {copied && <p role="status" className="mt-3 text-sm text-white/50">{copied === 'npub' || copied === 'nsec' ? `${copied} copied` : copied}</p>}
      </div>
    </div>
  );
}
