import Logo from './components/Logo';
import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import Button from './components/ui/Button';
import Keypad from './components/ui/Keypad';
import { MIN_PIN_LENGTH } from './lib/vaultLockout';
import { hasStoredPasskey } from './lib/passkeyRecord';
import Create from './components/onboarding/Create';
import SaveKey from './components/onboarding/SaveKey';
import VerifyKey from './components/onboarding/VerifyKey';
import SetupProfile from './components/onboarding/SetupProfile';
import Restore from './components/onboarding/Restore';
import RestoreMnemonic from './components/onboarding/RestoreMnemonic';
import { passkeyFailureCode, passkeyFailureMessage } from './lib/passkeyMessages';

export default function LockScreen({ identity }) {
  const [mode, setMode] = useState(() => {
    try {
      // A vault written before the 12-word confirm is a DRAFT, not an
      // account. Boot counts finished vaults only: an abandoned creation
      // relaunches into the create offer, never into a PIN gate over an
      // account the user never finished making (founder break 2026-10-27).
      const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
      // The per-account table is the authority once it has any entry; the
      // single legacy vault only speaks for installs that predate it.
      const hasVault = Object.keys(vaults).length > 0
        ? Object.values(vaults).some((v) => v && v.confirmed !== false)
        : !!localStorage.getItem('cipher_vault');
      return hasVault || localStorage.getItem('cipher_biometric_enabled') === 'true' ? 'unlock' : 'create';
    } catch (e) { return 'create'; }
  });

  // Unlock is this router's own screen; the six setup modes live in
  // components/onboarding/ and keep the identity.* calls word for word.
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [biometricLoading, setBiometricLoading] = useState(false);
  const [shake, setShake] = useState(0);

  // Shared handoff between the create rungs: Create -> SaveKey -> VerifyKey
  // -> SetupProfile.
  const [tempIdentity, setTempIdentity] = useState(null);
  const [savedMnemonic, setSavedMnemonic] = useState('');
  const [verifyIndices, setVerifyIndices] = useState([]);
  const [biometricNotice, setBiometricNotice] = useState('');
  const [createdHandle, setCreatedHandle] = useState('');

  const failAttempt = (message) => {
    setError(message);
    setShake((count) => count + 1);
  };

  const handleBiometricUnlock = async () => {
    if (biometricLoading || loading) return;
    if (!identity?.hasVault && pin.length < MIN_PIN_LENGTH) {
      failAttempt(`Enter a new PIN (exactly ${MIN_PIN_LENGTH} digits) before recovering this account on the device.`);
      return;
    }
    setBiometricLoading(true);
    setError('');
    try {
      const result = await identity.unlockWithBiometric(pin);
      // Plain words only: the authenticator's own message is never shown.
      // A cancellation is not a wrong PIN, so it does not shake the screen.
      if (!result.success) {
        if (result.code === 'cancelled') setError(passkeyFailureMessage(result));
        else failAttempt(passkeyFailureMessage(result));
      }
    } catch (biometricError) {
      console.error('[LockScreen] Passkey unlock failed:', biometricError);
      // A throw carries a code too: a cancellation the browser raised, not
      // returned, must not shake the screen or look like a wrong PIN.
      if (passkeyFailureCode(biometricError) === 'cancelled') setError(passkeyFailureMessage(biometricError));
      else failAttempt(passkeyFailureMessage(biometricError));
    } finally {
      setBiometricLoading(false);
    }
  };

  const handleUnlock = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await identity.unlock(pin);
      // res.error is the lockout copy straight from lib/vaultLockout —
      // "Wrong PIN. N attempts left." — shown word for word here. The wrong
      // digits are cleared so the retry starts empty: with dots as the only
      // display, staling them turns one careless miss into repeat strikes
      // toward the five-wrong-PINs wipe without the user ever seeing why.
      if (!res.success) { setPin(''); failAttempt(res.error || 'Invalid PIN'); }
    } catch (err) {
      // The PIN path answers in our own words only; the raw error goes to
      // the console. What can throw here is ours, not the user's to decode.
      console.error('[LockScreen] Unlock failed:', err);
      failAttempt('Something went wrong. Try your PIN again, or use your recovery phrase.');
    }
    setLoading(false);
  };

  const handleCreated = ({ res, cleanHandle, indices }) => {
    setBiometricNotice(res.biometricError || '');
    setTempIdentity(res);
    setCreatedHandle(cleanHandle);
    setSavedMnemonic(res.mnemonic || '');
    setVerifyIndices(indices);
    setMode('save_key');
  };

  return (
    <div className="relative flex h-[100dvh] w-full flex-col items-center justify-center overflow-y-auto bg-scrim px-6 py-12">
      <div className="pointer-events-none fixed inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="flex w-full max-w-sm flex-col items-center">

        <div className="mb-8">
          <Logo size={72} />
        </div>

        {mode === 'unlock' ? (
          <>
            <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Unlock Cipher</h1>
            <p className="mb-8 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Enter your PIN, or use your saved device passkey. Five wrong PINs delete this account from the device, including the encrypted recovery phrase.</p>

            <form onSubmit={handleUnlock} className="flex w-full flex-col items-center gap-4">
              <Keypad
                value={pin}
                maxLength={8}
                onChange={(next) => { setPin(next); setError(''); }}
                shake={shake}
                showBiometric={hasStoredPasskey(localStorage)}
                onBiometric={handleBiometricUnlock}
                biometricDisabled={biometricLoading || loading}
                disabled={loading}
              />
              {error && <p role="alert" className="max-w-[280px] text-center text-sm font-medium text-danger">{error}</p>}
              <Button type="submit" disabled={loading || biometricLoading} className="mt-2 flex w-full items-center justify-center gap-2">
                {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Unlock'}
              </Button>
            </form>

            <div className="mt-8 flex flex-col items-center gap-4">
              <button type="button" onClick={() => { setMode('restore'); setError(''); setPin('') }} className="text-sm font-medium text-inkMuted transition-colors hover:text-ink">
                Forgot PIN? Restore account
              </button>
              {identity?.hasBiometric && !identity?.hasVault && <p className="max-w-xs rounded-xl border border-line px-3 py-2 text-center text-xs text-inkMuted">If this device no longer has a local vault, enter a new PIN above before recovering with your saved passkey. Passkey recovery restores account access, not the 12-word phrase; keep your phrase backup safe.</p>}
            </div>
          </>
        ) : null}

        {mode === 'create' && <Create identity={identity} onCreated={handleCreated} go={setMode} />}
        {mode === 'save_key' && (
          <SaveKey savedMnemonic={savedMnemonic} biometricNotice={biometricNotice} onContinue={() => setMode('verify_key')} />
        )}
        {mode === 'verify_key' && (
          <VerifyKey savedMnemonic={savedMnemonic} verifyIndices={verifyIndices} onVerified={() => { identity.confirmVault(); setMode('setup_profile'); }} />
        )}
        {mode === 'setup_profile' && (
          <SetupProfile identity={identity} tempIdentity={tempIdentity} initialHandle={createdHandle} />
        )}
        {mode === 'restore' && <Restore identity={identity} go={setMode} />}
        {mode === 'restore_mnemonic' && <RestoreMnemonic identity={identity} go={setMode} />}
      </div>
    </div>
  );
}
