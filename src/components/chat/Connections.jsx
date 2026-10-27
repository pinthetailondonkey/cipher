import { useState } from 'react';
import { Globe, Shield, Users } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { pressable } from '../ui/Button';
import { readNetworkConfig, setRelayOverride } from '../../lib/egress.js';

// The screen's own settings live in one plain key, in the same shape the
// network config used here before: JSON in localStorage, read and written
// through try/catch so private mode loses nothing.
const SETTINGS_KEY = 'cipher_connections';
const EMPTY_SETTINGS = { tor: false, proxy: '' };

function readSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return EMPTY_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      tor: parsed?.tor === true,
      proxy: typeof parsed?.proxy === 'string' ? parsed.proxy : '',
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

function writeSettings(next) {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch { /* private mode */ }
  return next;
}

export default function Connections({ onBack }) {
  const [settings, setSettings] = useState(() => readSettings());
  const [relayUrl, setRelayUrl] = useState(
    () => String(readNetworkConfig().overrides?.['group-relay'] || ''),
  );

  const setTor = (tor) => setSettings(writeSettings({ ...settings, tor }));
  const setProxy = (proxy) => setSettings(writeSettings({ ...settings, proxy }));
  const setRelay = (url) => {
    setRelayOverride('group-relay', url);
    setRelayUrl(String(readNetworkConfig().overrides?.['group-relay'] || ''));
  };

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-safe">
      <ScreenHeader title="Connections" subtitle="Tor and your proxy" onBack={onBack} />
      <div className="space-y-4 p-4">
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <button
            type="button"
            role="switch"
            aria-checked={settings.tor === true}
            onClick={() => setTor(!settings.tor)}
            className={`flex w-full items-center gap-3 border-b border-line p-4 text-left active:bg-ink/5 ${pressable}`}
          >
            <Shield size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-ink">Tor</span>
              <span className="mt-0.5 block text-[13px] text-inkMuted">Remembered on this device.</span>
            </span>
            <span className={`relative h-6 w-11 shrink-0 rounded-full ${settings.tor ? 'bg-accent' : 'bg-ink/15'}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-ink transition-transform ${settings.tor ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </span>
          </button>
          <p className="p-4 text-[13px] leading-snug text-inkMuted">
            {settings.tor
              ? 'Tor is on. Routing still follows the device: the installed app uses its own Tor, and a browser needs Tor Browser or Orbot.'
              : 'Tor is off. Routing still follows the device: the installed app uses its own Tor, and a browser needs Tor Browser or a VPN for IP privacy.'}
          </p>
          <p className="border-t border-line p-4 text-[13px] leading-snug text-inkMuted">
            Android: Orbot’s VPN mode. iOS: Onion Browser or the mirror. Calls use UDP, so Tor Browser alone won’t cover them; Orbot’s VPN mode will.
          </p>
        </div>
        <label className="block rounded-2xl border border-line bg-panel p-4">
          <span className="flex items-center gap-3">
            <Globe size={24} className="shrink-0 text-inkSubtle" />
            <span className="block text-[15px] font-semibold text-ink">Proxy</span>
          </span>
          <span className="mt-0.5 block text-[13px] text-inkMuted">One address for every connection.</span>
          <input
            value={settings.proxy}
            onChange={(event) => setProxy(event.target.value)}
            spellCheck="false"
            autoComplete="off"
            inputMode="url"
            placeholder="socks5://127.0.0.1:9050"
            className="mt-3 w-full rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[13px] text-ink outline-none placeholder:text-inkSubtle focus:border-lineStrong"
          />
          <p className="mt-2 text-[13px] leading-snug text-inkMuted">
            A browser tab cannot set its own proxy — the browser decides. The installed app sets its proxy before any page loads. On Tails, tor already runs on 127.0.0.1:9050; leave this empty and it is used.
          </p>
        </label>
        <label className="block rounded-2xl border border-line bg-panel p-4">
          <span className="flex items-center gap-3">
            <Users size={24} className="shrink-0 text-inkSubtle" />
            <span className="block text-[15px] font-semibold text-ink">Group relay</span>
          </span>
          <span className="mt-0.5 block text-[13px] text-inkMuted">Your own address for groups, remembered on this device.</span>
          <input
            value={relayUrl}
            onChange={(event) => setRelay(event.target.value)}
            spellCheck="false"
            autoComplete="off"
            inputMode="url"
            placeholder="wss://…onion — empty for the default"
            className="mt-3 w-full rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[13px] text-ink outline-none placeholder:text-inkSubtle focus:border-lineStrong"
          />
          <p className="mt-2 text-[13px] leading-snug text-inkMuted">
            {relayUrl
              ? 'Using your own address. Clear this box to go back to the default.'
              : 'Using the app’s default address. Paste an onion address here to reach groups through Tor on this device.'}
          </p>
        </label>
        <div className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-[13px] leading-snug text-inkMuted">The other relay rows stay gone. The app talks to its own hosts; the group relay is the one address you can name yourself.</p>
        </div>
      </div>
    </div>
  );
}
