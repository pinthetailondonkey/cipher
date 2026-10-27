import Logo from './components/Logo';
import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import Button from './components/ui/Button';
import Keypad from './components/ui/Keypad';
import { MIN_PIN_LENGTH } from './lib/vaultLockout';
import Create from './components/onboarding/Create';
import SaveKey from './components/onboarding/SaveKey';
import VerifyKey from './components/onboarding/VerifyKey';
import SetupProfile from './components/onboarding/SetupProfile';
import Restore from './components/onboarding/Restore';
import RestoreMnemonic from './components/onboarding/RestoreMnemonic';

// The vow lines for a cold landing at the app's root (founder order, verbatim
// from the parked download-page copy in docs/DESKTOP.md). Words only: this
// block touches no styling, no layout, no relay name. It shows on a device's
// first open only — the flag goes up once it has been shown, so a returning
// user skips straight to the pin pad.
const VOWS_SEEN_KEY = 'cipher_first_run_vows_seen';

const VOW_LEAD = "A messenger and a shop for your phone's browser, or your own computer.";

const VOW_LINES = [
  'Cipher is a messenger and a shop. Your messages, payments and pictures travel encrypted, and nothing here reports back to us.',
  'The desktop app routes everything through Tor, built in — your address never rides the envelope in the clear.',
  'Prefer the browser version? Run a VPN alongside it — it keeps your IP address harder to see.',
];

function firstRunVowsOwed() {
  try {
    return !localStorage.getItem(VOWS_SEEN_KEY);
  } catch {
    return false;
  }
}

export default function LockScreen({ identity }) {
  const [showVows] = useState(firstRunVowsOwed);

  // The flag rides the show: set once when the vows render, so a returning
  // user never sees them twice. Private mode keeps re-showing next open —
  // the write failing silently is the honest behavior there.
  useEffect(() => {
    if (!showVows) return;
    try {
      localStorage.setItem(VOWS_SEEN_KEY, '1');
    } catch { /* private mode */ }
  }, [showVows]);

  const [mode, setMode] = useState(() => {
    try {
      const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
      const hasVault = !!localStorage.getItem('cipher_vault') || Object.keys(vaults).length > 0;
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
      failAttempt(`Enter a new PIN (at least ${MIN_PIN_LENGTH} digits) before recovering this account on the device.`);
      return;
    }
    setBiometricLoading(true);
    setError('');
    try {
      const result = await identity.unlockWithBiometric(pin);
      if (!result.success) failAttempt(result.error || 'Passkey unlock failed. Use your PIN or recovery phrase.');
    } catch (biometricError) {
      console.error('[LockScreen] Passkey unlock failed:', biometricError);
      failAttempt(biometricError?.message || 'Passkey unlock failed. Use your PIN or recovery phrase.');
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
      // "Wrong PIN. N attempts left." — shown word for word here.
      if (!res.success) failAttempt(res.error || 'Invalid PIN');
    } catch (err) {
      failAttempt(err?.message || 'Something went wrong');
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

        {showVows && (
          <div className="mb-8 w-full max-w-[280px]">
            <p className="mb-3 text-center text-[13px] font-medium leading-relaxed text-ink">{VOW_LEAD}</p>
            {VOW_LINES.map((line) => (
              <p key={line} className="text-center text-[12px] leading-relaxed text-inkMuted">{line}</p>
            ))}
          </div>
        )}

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
                showBiometric={!!identity?.hasBiometric}
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
          <VerifyKey savedMnemonic={savedMnemonic} verifyIndices={verifyIndices} onVerified={() => setMode('setup_profile')} />
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
