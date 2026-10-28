import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';

// VerifyKey — the 3 random word spots (§10). The "Word #N" label sits ABOVE
// its input now (12px caption), so the label can never ride on top of the
// typed word the way the old floating overlay did.
export default function VerifyKey({ savedMnemonic, verifyIndices, onVerified }) {
  const [verifyInputs, setVerifyInputs] = useState(['', '', '']);
  const [verifyError, setVerifyError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleVerifyKey = (e) => {
    e.preventDefault();
    const words = (savedMnemonic || '').split(' ');
    const allCorrect = verifyIndices.every((idx, i) =>
      verifyInputs[i].trim().toLowerCase() === (words[idx] || '').toLowerCase()
    );
    if (!allCorrect) {
      setVerifyError('Some words are incorrect. Go back and check your phrase.');
      return;
    }
    setVerifyError('');
    setLoading(true);
    onVerified();
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Verify Your Recovery Key</h1>
      <p className="mb-5 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Enter the words below to confirm you saved the phrase.</p>

      <form onSubmit={handleVerifyKey} className="flex w-full flex-col gap-4 rounded-3xl border border-line bg-panel p-6">
        <p className="mb-1 text-sm text-inkMuted">Enter words #{verifyIndices.map(i => i + 1).join(', #')} from your recovery phrase</p>
        {verifyIndices.map((idx, i) => (
          <div key={idx}>
            <label htmlFor={`verify-word-${i}`} className="mb-1 block text-[12px] font-medium text-inkMuted">Word #{idx + 1}</label>
            <Input
              id={`verify-word-${i}`}
              type="text"
              placeholder="..."
              value={verifyInputs[i] || ''}
              onChange={(e) => { const newInputs = [...verifyInputs]; newInputs[i] = e.target.value.toLowerCase().trim(); setVerifyInputs(newInputs); setVerifyError(''); }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
            />
          </div>
        ))}
        {verifyError && <p className="mt-2 text-center text-xs text-danger">{verifyError}</p>}
        <Button type="submit" disabled={loading || verifyInputs.some(v => !v.trim())} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : 'Verify & Continue'}
        </Button>
      </form>
    </>
  );
}
