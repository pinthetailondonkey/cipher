import { useState } from 'react';
import { Link2 } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { listEgress, setRelayOverride } from '../../lib/egress';

// There is deliberately no settings key here. This screen used to carry a Tor
// switch and a proxy field that wrote to one localStorage key and routed
// nothing — nothing outside this file ever read it. A control that looks like
// a setting and changes only the paragraph under it is worse than no control,
// because the user believes a choice was made. What is left on this screen is
// two paste rows whose overrides the watcher and the push gateway really read.

function readEgressRows() {
  const rows = listEgress();
  return Object.fromEntries(PASTEABLE.map(({ id }) => [id, rows.find((row) => row.id === id) || { override: '', active: '' }]));
}

// The two rows a vendor has to be able to paste into: the watcher that is
// the only thing allowed to move a payment to seen or confirmed, and the
// gateway a locked phone buzzes through. They are egress entries with no
// shipped address, so the paste is an override on the entry itself — the
// same store every other row reads, which is why Check the chain and push
// start working the moment one is filled in and say plainly when it is not.
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
];

export default function Connections({ onBack }) {
  const [services, setServices] = useState(() => readEgressRows());

  const setService = (id, url) => {
    setRelayOverride(id, url);
    setServices(readEgressRows());
  };

  return (
    <div className="h-full overflow-y-auto bg-transparent">
      <ScreenHeader title="Connections" subtitle="Payment watcher and push gateway" onBack={onBack} />
      <div className="space-y-4 p-4">
        <div className="space-y-4">
          {PASTEABLE.map(({ id, label, placeholder, empty }) => {
            const row = services[id] || { override: '', active: '' };
            const set = Boolean(row.override);
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
                  {set ? `In use: ${row.active || row.override}` : empty}
                </p>
              </label>
            );
          })}
        </div>
        <div className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-[13px] leading-snug text-inkMuted">Messages and groups talk to their own hosts, and the defaults hold. Clear a row above to go back to none.</p>
        </div>
      </div>
    </div>
  );
}
