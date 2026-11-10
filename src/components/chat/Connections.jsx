import { useState } from 'react';
import { Link2 } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { listEgress, setRelayOverride } from '../../lib/egress';
import { pinPaymentWatcherKey, readPaymentWatcherPin, rotatePaymentWatcherKey, clearPaymentWatcherPin } from '../../lib/paymentWatcherTrust';

// This screen used to carry a Tor switch and a proxy field that wrote to one
// localStorage key and routed nothing. The rows below are limited to settings
// the app actually reads: the payment watcher, push gateway, and media servers.

function readEgressRows() {
  const rows = listEgress();
  return Object.fromEntries(PASTEABLE.map(({ id }) => [id, rows.find((row) => row.id === id) || { override: '', active: '' }]));
}

// The watcher and push rows have no shipped address; the three media rows
// are the named Blossom servers. A saved media override also becomes the
// exact-origin allowlist used by the render gate.
const PASTEABLE = [
  {
    id: 'explorer',
    label: 'Payment watcher',
    placeholder: 'https://…/payment?token=…',
    empty: 'Not set. A payment cannot be marked seen or confirmed from the chain until you paste the watcher you run.',
  },
  {
    id: 'push',
    label: 'Push gateway',
    placeholder: 'https://…/cipher-push.json',
    empty: 'Not set. A locked phone does not buzz until you paste the gateway you run.',
  },
  {
    id: 'blossom-primal',
    label: 'Media server 1',
    placeholder: 'https://… or off',
    empty: 'Uses the configured default. This origin may load photos and voice notes.',
  },
  {
    id: 'blossom-nostr-build',
    label: 'Media server 2',
    placeholder: 'https://… or off',
    empty: 'Uses the configured default. This origin may load photos and voice notes.',
  },
  {
    id: 'blossom-band',
    label: 'Media server 3',
    placeholder: 'https://… or off',
    empty: 'Uses the configured default. This origin may load photos and voice notes.',
  },
];

export default function Connections({ onBack }) {
  const [services, setServices] = useState(() => readEgressRows());
  const [pinnedKey, setPinnedKey] = useState(() => readPaymentWatcherPin());
  const [keyDraft, setKeyDraft] = useState('');
  const [rotationSignature, setRotationSignature] = useState('');
  const [pinMessage, setPinMessage] = useState('');
  const [pinError, setPinError] = useState('');

  const setService = (id, url) => {
    setRelayOverride(id, url);
    setServices(readEgressRows());
  };

  return (
    <div className="h-full overflow-y-auto bg-transparent">
      <ScreenHeader title="Connections" subtitle="Payment, push, and media servers" onBack={onBack} />
      <div className="space-y-4 p-4">
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="text-[15px] font-semibold text-ink">Payment watcher signing key</h2>
          <p className="mt-2 text-[13px] leading-snug text-inkMuted">Copy the Ed25519 public key from the watcher you run. Payment reports stay on hold until this key is pinned. The access token does not verify reports.</p>
          <input value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} spellCheck="false" autoComplete="off" aria-label="Payment watcher signing key" placeholder="Ed25519 public key (base64url)" className="mt-3 w-full rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[13px] text-ink outline-none placeholder:text-inkSubtle focus:border-lineStrong" />
          {pinnedKey ? <>
            <p className="mt-2 break-all text-[12px] text-inkSubtle">Pinned key: {pinnedKey}</p>
            <input value={rotationSignature} onChange={(event) => setRotationSignature(event.target.value)} spellCheck="false" autoComplete="off" aria-label="Watcher key rotation signature" placeholder="Current key’s rotation signature" className="mt-3 w-full rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[13px] text-ink outline-none placeholder:text-inkSubtle focus:border-lineStrong" />
            <button type="button" onClick={async () => {
              setPinError(''); setPinMessage('');
              try { await rotatePaymentWatcherKey({ publicKey: keyDraft, signature: rotationSignature, confirmRotation: window.confirm('Rotate the payment watcher signing key?') }); setPinnedKey(readPaymentWatcherPin()); setRotationSignature(''); setPinMessage('Watcher signing key rotated.'); }
              catch (error) { setPinError(error.message); }
            }} className="mt-3 min-h-[40px] rounded-xl border border-line px-4 text-[13px] font-semibold text-ink">Rotate signing key</button>
            <button type="button" onClick={() => {
              setPinError(''); setPinMessage('');
              try {
                clearPaymentWatcherPin({ confirmRemoval: window.confirm('Remove this watcher pin? Payment reports will stay on hold until you independently check and pin a replacement key.') });
                setPinnedKey(''); setPinMessage('Watcher key pin removed. Payment reports are on hold until another key is pinned.');
              } catch (error) { setPinError(error.message); }
            }} className="ml-2 mt-3 min-h-[40px] rounded-xl border border-line px-4 text-[13px] font-semibold text-ink">Remove pin</button>
          </> : <button type="button" onClick={async () => {
            setPinError(''); setPinMessage('');
            try { await pinPaymentWatcherKey(keyDraft); setPinnedKey(readPaymentWatcherPin()); setPinMessage('Watcher signing key pinned.'); }
            catch (error) { setPinError(error.message); }
          }} className="mt-3 min-h-[40px] rounded-xl border border-line px-4 text-[13px] font-semibold text-ink">Pin signing key</button>}
          {pinMessage && <p role="status" className="mt-2 text-[13px] text-success">{pinMessage}</p>}
          {pinError && <p role="alert" className="mt-2 text-[13px] text-danger">{pinError}</p>}
        </section>
        <div className="space-y-4">
          {PASTEABLE.map(({ id, label, placeholder, empty }) => {
            const row = services[id] || { override: '', active: '' };
            const set = Boolean(row.override);
            const disabled = row.override.toLowerCase() === 'off';
            return (
              <label key={id} className="block rounded-2xl border border-line bg-panel p-4">
                <span className="flex items-center gap-3">
                  <Link2 size={24} className="shrink-0 text-inkSubtle" />
                  <span className="block text-[15px] font-semibold text-ink">{label}</span>
                </span>
                <input
                  value={row.override}
                  onChange={(event) => setService(id, event.target.value)}
                  spellCheck="false"
                  autoComplete="off"
                  inputMode="url"
                  aria-label={label}
                  placeholder={placeholder}
                  className="mt-3 w-full rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[13px] text-ink outline-none placeholder:text-inkSubtle focus:border-lineStrong"
                />
                <p className="mt-2 text-[13px] leading-snug text-inkMuted">
                  {disabled ? 'Off. Media from this server will not load.' : set ? `In use: ${row.active || row.override}` : empty}
                </p>
              </label>
            );
          })}
        </div>
        <div className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-[13px] leading-snug text-inkMuted">
            Messages and groups use their listed hosts. Photos and voice notes load only from this app or the media origins above. A media server can see your IP address, the file requested, and when you opened it. A sender cannot make your device contact a different origin just by putting it in a message or profile. Saving an origin approves its exact scheme, host, and port on this device; type off to disable a server or clear the field to restore its default.
          </p>
        </div>
      </div>
    </div>
  );
}
