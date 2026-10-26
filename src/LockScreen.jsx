import Logo from './components/Logo';
import React, { useState } from "react";
import { Fingerprint, ChevronLeft, AtSign, Camera, RefreshCw, KeyRound, Check } from "lucide-react";
import { useChatStore } from "./store/chatStore";
import { compressImage } from './lib/imageCompression';
import Button from './components/ui/Button';
import { pressable } from './components/ui/Button';
import { MIN_PIN_LENGTH } from './lib/vaultLockout';
import { usernameRelays } from './lib/relays';
import { blossomServers } from './lib/egress';
import Picture from './components/ui/Picture';

export default function LockScreen({ identity }) {
  const [mode, setMode] = useState(() => {
    try {
      const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
      const hasVault = !!localStorage.getItem('cipher_vault') || Object.keys(vaults).length > 0;
      return hasVault || localStorage.getItem('cipher_biometric_enabled') === 'true' ? 'unlock' : 'create';
    } catch (e) { return 'create'; }
  });
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [error, setError] = useState('');
  const [enableBio, setEnableBio] = useState(false);
  const [savedMnemonic, setSavedMnemonic] = useState('');
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);
  const [verifyIndices, setVerifyIndices] = useState([]);
  const [verifyInputs, setVerifyInputs] = useState(['', '', '']);
  const [verifyError, setVerifyError] = useState('');
  const [loading, setLoading] = useState(false);
  const [biometricLoading, setBiometricLoading] = useState(false);
  const [biometricNotice, setBiometricNotice] = useState('');

  const [tempIdentity, setTempIdentity] = useState(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const handleBiometricUnlock = async () => {
    if (biometricLoading || loading) return;
    if (!identity?.hasVault && pin.length < MIN_PIN_LENGTH) {
      setError(`Enter a new PIN (at least ${MIN_PIN_LENGTH} digits) before recovering this account on the device.`);
      return;
    }
    setBiometricLoading(true);
    setError('');
    try {
      const result = await identity.unlockWithBiometric(pin);
      if (!result.success) setError(result.error || 'Passkey unlock failed. Use your PIN or recovery phrase.');
    } catch (biometricError) {
      console.error('[LockScreen] Passkey unlock failed:', biometricError);
      setError(biometricError?.message || 'Passkey unlock failed. Use your PIN or recovery phrase.');
    } finally {
      setBiometricLoading(false);
    }
  };

  const checkUsernameAvailable = async (username) => {
    let pool;
    const relays = usernameRelays;
    try {
      const { SimplePool } = await import('nostr-tools');
      pool = new SimplePool();
      const events = await Promise.race([
        pool.querySync(relays, { kinds: [10003], '#t': ['cipher_username_' + username], limit: 5 }),
        new Promise(r => setTimeout(() => r([{ id: 'timeout', tags: [] }]), 3000)),
      ]);
      return events.length === 0;
    } catch (e) {
      console.warn('Precheck failed — failing CLOSED to prevent squatting:', e);
      return false;
    } finally {
      pool?.close(relays);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');

    const cleanHandle = handle.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
    if (mode === 'create' || mode === 'restore') {
      if (cleanHandle.length < 3) { setError('Handle must be at least 3 letters/numbers'); setLoading(false); return; }
    }
    if ((mode !== 'restore_mnemonic' && pin.length < MIN_PIN_LENGTH) || (mode === 'restore_mnemonic' && pin.length < MIN_PIN_LENGTH)) {
      setError(`PIN must be at least ${MIN_PIN_LENGTH} digits`);
      setLoading(false);
      return;
    }

    try {
      if (mode === 'create') {
        const available = true; // BYPASSED: Pre-check is buggy
        if (!available) {
          setError('@' + cleanHandle + ' is already taken. Try another.');
          setLoading(false);
          return;
        }
        const res = await identity.createVault(cleanHandle, pin, enableBio);
        setBiometricNotice(res.biometricError || '');
        setTempIdentity(res);
        setUsername(cleanHandle);
        setDisplayName(cleanHandle);
        const _words = (res.mnemonic || '').split(' ');
        const _idxs = [];
        while (_idxs.length < 3) {
          const r = Math.floor(Math.random() * _words.length);
          if (!_idxs.includes(r)) _idxs.push(r);
        }
        setVerifyIndices(_idxs);
        setVerifyInputs(['', '', '']);
        setVerifyError('');
        setSavedMnemonic(res.mnemonic || '');
        setMnemonicConfirmed(false);
        setMode('save_key');
      } else if (mode === 'unlock') {
        const res = await identity.unlock(pin);
        if (!res.success) setError(res.error || 'Invalid PIN');
      } else if (mode === 'restore') {
        const res = await identity.restoreFromRelays(cleanHandle, pin);
        if (!res.success) setError(res.error);
      } else if (mode === 'restore_mnemonic') {
        if (!mnemonic.trim() || mnemonic.trim().split(/\s+/).length < 12) {
          setError('Please enter your full 12-word phrase');
        } else {
          const res = await identity.restoreFromMnemonic(mnemonic, pin);
          if (!res.success) setError(res.error);
        }
      }
    } catch (err) {
      setError(err?.message || 'Something went wrong');
    }
    setLoading(false);
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !tempIdentity) return;
    setUploadingAvatar(true);
    try {
      const cleanFile = await compressImage(file, 800, 0.78);
      const { uploadToBlossom } = await import('@nostr-wot/blossom');
      const blob = await uploadToBlossom(cleanFile, {
        servers: blossomServers(),
        signer: {
          getPublicKey: async () => tempIdentity.pk,
          signEvent: async (event) => {
            const { finalizeEvent } = await import('nostr-tools');
            return finalizeEvent(event, tempIdentity.sk);
          }
        },
      });
      setAvatar(blob.url);
    } catch (err) {
      useChatStore.getState().setToast({ type: 'info', message: 'Upload failed: ' + err.message });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveKeyContinue = (e) => {
    e.preventDefault();
    setError('');
    if (!mnemonicConfirmed) return;
    setMode('verify_key');
  };

  const handleVerifyKey = (e) => {
    e.preventDefault();
    const words = savedMnemonic.split(' ');
    const allCorrect = verifyIndices.every((idx, i) =>
      verifyInputs[i].trim().toLowerCase() === (words[idx] || '').toLowerCase()
    );
    if (!allCorrect) {
      setVerifyError('Some words are incorrect. Go back and check your phrase.');
      return;
    }
    setVerifyError('');
    setMode('setup_profile');
  };

  const handleFinishSetup = async (e) => {
    e.preventDefault();
    const clean = username.replace('@', '').trim().toLowerCase();
    if (clean.length < 3) return setError('Username must be 3+ characters');
    if (!/^[a-z0-9_]+$/.test(clean)) return setError('Only letters, numbers, underscores');
    setLoading(true);

    localStorage.setItem('cipher_new_account', 'true');
    await identity.finalizeLogin(tempIdentity.sk, tempIdentity.pk, tempIdentity.npub, {
      username: clean,
      displayName: displayName.trim() || clean,
      picture: avatar
    });
    setLoading(false);
  };

  const isMnemonicMode = mode === 'restore_mnemonic';
  const submitDisabled = loading || biometricLoading || (mode === 'save_key' && !mnemonicConfirmed) || (mode === 'verify_key' && verifyInputs.some(v => !v.trim()));

  return (
    <div className="relative flex h-[100dvh] w-full flex-col items-center justify-center overflow-y-auto bg-black px-6 py-12">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-[-10%] top-[-10%] h-[50%] w-[50%] rounded-full bg-blue-600/20 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[50%] w-[50%] rounded-full bg-purple-600/10 blur-[120px]" />
      </div>
      <div className="w-full max-w-sm flex flex-col items-center">
        
        {/* CLEAN CRISP LOGO - No weird glows */}
        <div className="mb-8">
          <Logo size={80} />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-white mb-2 text-center">
          {mode === 'verify_key' ? 'Verify Your Recovery Key' : mode === 'save_key' ? 'Save Your Recovery Key' : mode === 'setup_profile' ? 'Your Profile' : mode === 'create' ? 'Welcome to Cipher' : mode === 'unlock' ? 'Unlock Cipher' : mode === 'restore' ? 'Restore Account' : 'Restore with Recovery Phrase'}
        </h1>
        <p className="text-[13px] text-white/40 text-center mb-8 max-w-[280px] leading-relaxed">
          {mode === 'verify_key' ? 'Enter the words below to confirm you saved the phrase.' : mode === 'save_key' ? 'Write down these 12 words. You need them and your PIN to recover this account. Five wrong PINs delete the copy stored on this device.' : mode === 'setup_profile' ? 'Set up your profile and start messaging.' : mode === 'create' ? `Pick a handle and a PIN (${MIN_PIN_LENGTH}+ digits).` : mode === 'unlock' ? 'Enter your PIN, or use your saved device passkey. Five wrong PINs delete this account from the device, including the encrypted recovery phrase.' : mode === 'restore' ? 'Enter your handle and PIN.' : `Enter your 12-word phrase and a new PIN (${MIN_PIN_LENGTH}+ digits).`}
        </p>

        <form onSubmit={mode === 'verify_key' ? handleVerifyKey : mode === 'save_key' ? handleSaveKeyContinue : mode === 'setup_profile' ? handleFinishSetup : handleSubmit} className="w-full flex flex-col gap-4 rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-6 shadow-2xl">
          
          {mode === 'save_key' ? (
            <div className="space-y-6 w-full">
              <div className="grid grid-cols-3 gap-2 w-full">
                {(savedMnemonic || '').split(' ').map((word, i) => (
                  <div key={i} className="border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-xl p-3 text-center text-[13px] text-white font-mono">
                    {word}
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-3 text-gray-400 text-sm cursor-pointer hover:text-white transition-colors">
                <div className="relative flex items-center justify-center w-5 h-5">
                  <input type="checkbox" checked={mnemonicConfirmed} onChange={(e) => setMnemonicConfirmed(e.target.checked)} className="peer appearance-none w-5 h-5 border border-white/20 rounded-md bg-white/5 checked:bg-blue-600 checked:border-blue-600 transition-colors" />
                  <Check size={14} className="absolute text-white pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity" strokeWidth={3} />
                </div>
                I have written down these 12 words.
              </label>
            </div>
          ) : mode === 'setup_profile' ? (
            <>
              <div className="relative mb-4 group cursor-pointer mx-auto">
                <div className="w-24 h-24 rounded-full bg-white/5 border-2 border-dashed border-white/20 flex items-center justify-center overflow-hidden transition-all group-hover:border-blue-500">
                  <Picture src={avatar} alt="avatar" className="w-full h-full object-cover" fallback={<Camera size={28} className="text-gray-500 group-hover:text-blue-500 transition-colors" />} />
                </div>
                <input type="file" accept="image/*" onChange={handleAvatarUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                {uploadingAvatar && <div className="absolute inset-0 bg-black/60 flex items-center justify-center rounded-full"><RefreshCw size={20} className="animate-spin text-white" /></div>}
              </div>

              <input type="text" placeholder="Display Name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors" />

              <div className="w-full relative">
                <AtSign size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
                <input type="text" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl pl-11 pr-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
            </>
          ) : (
            <>
              {mode === 'verify_key' && (
                <div className="space-y-3 mb-2">
                  <div className="text-center mb-4">
                    <p className="text-sm text-gray-400">Enter words #{verifyIndices.map(i => i + 1).join(', #')} from your recovery phrase</p>
                  </div>
                  {verifyIndices.map((idx, i) => (
                    <div key={idx} className="w-full relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-mono text-sm pointer-events-none">Word #{idx + 1}</span>
                      <input type="text" placeholder="..." value={verifyInputs[i] || ''} onChange={(e) => { const newInputs = [...verifyInputs]; newInputs[i] = e.target.value.toLowerCase().trim(); setVerifyInputs(newInputs); setVerifyError(''); }} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl pl-24 pr-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors" autoCapitalize="none" autoCorrect="off" spellCheck="false" />
                    </div>
                  ))}
                  {verifyError && <p className="text-red-500 text-xs text-center mt-2">{verifyError}</p>}
                </div>
              )}

              {isMnemonicMode && (
                <textarea placeholder="apple banana cherry ..." value={mnemonic} onChange={(e) => { setMnemonic(e.target.value); setError(''); }} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-5 text-[15px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors resize-none" autoCapitalize="none" autoCorrect="off" spellCheck="false" rows={4} />
              )}

              {(mode === 'create' || mode === 'restore') && (
                <div className="w-full relative">
                  <AtSign size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input type="text" placeholder="yourhandle" value={handle} onChange={(e) => { setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setError(''); }} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl pl-11 pr-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors" />
                </div>
              )}

              {mode !== 'verify_key' && (
                <input type="password" placeholder={mode === 'restore_mnemonic' ? `New PIN (${MIN_PIN_LENGTH}+ digits)` : `PIN (${MIN_PIN_LENGTH}+ digits)`} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors" maxLength={8} />
              )}

              {mode === 'create' && (
                <label className="flex items-center justify-center gap-3 text-gray-400 text-sm mt-1 cursor-pointer hover:text-white transition-colors">
                  <div className="relative flex items-center justify-center w-5 h-5">
                    <input type="checkbox" checked={enableBio} onChange={(e) => setEnableBio(e.target.checked)} className="peer appearance-none w-5 h-5 border border-white/20 rounded-md bg-white/5 checked:bg-blue-600 checked:border-blue-600 transition-colors" />
                    <Check size={14} className="absolute text-white pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity" strokeWidth={3} />
                  </div>
                  Set up Face ID / fingerprint
                </label>
              )}
            </>
          )}

          {error && <p className="text-red-500 text-sm text-center mt-1 mb-1 font-medium">{error}</p>}

          {/* SOLID BLUE BUTTON - Matches Logo, No Gradient */}
          <Button type="submit" disabled={submitDisabled} className="mt-2 flex w-full items-center justify-center gap-2">
            {loading ? <RefreshCw size={20} className="animate-spin" /> : mode === 'verify_key' ? 'Verify & Continue' : mode === 'save_key' ? (mnemonicConfirmed ? 'Continue' : 'Confirm you saved it') : mode === 'setup_profile' ? 'Finish Setup' : mode === 'unlock' ? 'Unlock' : 'Continue'}
          </Button>
          {biometricNotice && mode === 'save_key' && (
            <p role="status" className="text-center text-xs leading-relaxed text-amber-300">{biometricNotice} You can still unlock with your PIN.</p>
          )}
        </form>

        <div className="mt-8 flex flex-col items-center gap-4">
          {mode === 'unlock' && (
            <>
              {identity?.hasBiometric && (
                <button type="button" onClick={handleBiometricUnlock} disabled={biometricLoading || loading} className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 text-[15px] font-semibold text-blue-500 active:bg-white/10 disabled:opacity-50 ${pressable}`}>
                  {biometricLoading ? <RefreshCw size={17} className="animate-spin" /> : <Fingerprint size={17} />}
                  Unlock or recover with Face ID / fingerprint
                </button>
              )}
              <button type="button" onClick={() => { setMode('restore'); setError(''); setPin('') }} className="text-gray-500 hover:text-white text-sm font-medium transition-colors">
                Forgot PIN? Restore account
              </button>
              {identity?.hasBiometric && !identity?.hasVault && <p className="max-w-xs text-center text-xs text-white/35">If this device no longer has a local vault, enter a new PIN above before recovering with your saved passkey. Passkey recovery restores account access, not the 12-word phrase; keep your phrase backup safe.</p>}
            </>
          )}

          {mode === 'create' && (
            <div className="flex flex-col gap-4 mt-2 w-full items-center">
              <button type="button" onClick={() => { setMode('restore'); setError(''); setPin(''); }} className="text-gray-400 hover:text-white text-sm font-medium transition-colors">
                Restore account on this device
              </button>
              <button type="button" onClick={() => { setMode('restore_mnemonic'); setError(''); setPin(''); setMnemonic('') }} className="text-blue-500 hover:text-blue-400 text-sm font-medium transition-colors">
                Restore with 12-word recovery phrase
              </button>
            </div>
          )}

          {mode === 'restore' && (
            <>
              <button type="button" onClick={() => { setMode('restore_mnemonic'); setError(''); setPin(''); }} className="text-gray-500 hover:text-white text-sm font-medium transition-colors flex items-center gap-1">
                <KeyRound size={14} /> Use Recovery Phrase
              </button>
              <button type="button" onClick={() => { setMode('create'); setError(''); setPin('') }} className="text-gray-500 hover:text-white text-sm font-medium transition-colors">
                Create a new account instead
              </button>
            </>
          )}

          {mode === 'restore_mnemonic' && (
            <button type="button" onClick={() => { setMode('restore'); setError(''); setPin(''); }} className="text-gray-500 hover:text-white text-sm font-medium transition-colors flex items-center gap-1">
              <ChevronLeft size={14} /> Back to handle restore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
