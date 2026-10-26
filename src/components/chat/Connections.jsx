import { useState } from 'react';
import ScreenHeader from '../ui/ScreenHeader';
import { listEgress, readNetworkConfig, setRelayList, setRelayOverride } from '../../lib/egress';

const LABEL = {
  tor: 'Tor',
  clearnet: 'Clearnet',
  blocked: 'Blocked',
  unused: 'Not used',
  depends: 'Depends',
  off: 'Off',
  unset: 'Not set',
};

function pageBlocksPlainOnion(url) {
  if (typeof window === 'undefined') return false;
  if (!String(url || '').startsWith('ws://') && !String(url || '').startsWith('http://')) return false;
  if (!String(url).includes('.onion')) return false;
  return window.location.protocol === 'https:' && !window.location.hostname.endsWith('.onion');
}

export default function Connections({ onBack }) {
  const [config, setConfig] = useState(() => readNetworkConfig());
  const [advanced, setAdvanced] = useState(false);
  const rows = listEgress(config);

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-safe">
      <ScreenHeader title="Connections" subtitle="Every host this app can reach" onBack={onBack} />
      <div className="space-y-4 p-4">
        <div className="rounded-2xl border border-line bg-panel p-4 shadow-lg">
          <p className="text-[15px] font-semibold text-ink">For IP privacy, use Tor Browser or a VPN. The app doesn’t manage this.</p>
          <p className="mt-2 text-[13px] leading-snug text-ink/50">Android: Orbot VPN mode. iOS: Onion Browser or the mirror.</p>
          <p className="mt-2 text-[13px] leading-snug text-ink/50">On Tails, the browser forgets everything at shutdown. Each boot: bring your key backup, unlock, and paste your rows again.</p>
          <p className="mt-2 text-[13px] leading-snug text-ink/50">Calls reveal your IP unless you route everything. Calls use UDP, so Tor Browser alone won’t cover them. Orbot’s VPN mode will.</p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          {rows.map((row) => (
            <div key={row.id} className="border-b border-ink/5 p-4 last:border-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-ink">{row.role}</p>
                  <p className="mt-0.5 break-all text-[13px] text-ink/70">{row.active || row.url || row.hint || 'Not set'}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${row.transport === 'tor' ? 'bg-accent text-accentInk' : row.transport === 'blocked' ? 'bg-rose-500/20 text-rose-200' : 'bg-ink/10 text-ink/70'}`}>
                  {LABEL[row.transport] || row.transport}
                </span>
              </div>
              <p className="mt-2 text-[13px] text-ink/40">{row.sees}</p>
              {pageBlocksPlainOnion(row.active) && (
                <p className="mt-2 text-[13px] text-amber-300">This page is HTTPS, so a plain onion socket is blocked. Open it in Tor Browser, or use a TLS socket.</p>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setAdvanced((open) => !open)} aria-expanded={advanced} className="w-full rounded-2xl border border-line bg-panel px-4 py-3 text-left text-[15px] font-semibold text-ink shadow-lg active:scale-95">
          Advanced
          <span className="mt-0.5 block text-[13px] font-normal text-ink/40">{advanced ? 'Hide relay changes' : 'Change a relay'}</span>
        </button>
        {advanced && (
          <div className="space-y-4">
            <p className="text-[13px] leading-snug text-ink/50">An onion relay needs Tor Browser or Orbot. Paste it on a row with its scheme included — a TLS onion starts wss://, and a plain ws:// or http:// onion only opens when this page itself is open over Tor. Or point a row at a box you run. Type off to stop using that host. Defaults work if you change nothing. Restart after a change.</p>
            <label className="block rounded-2xl border border-line bg-panel p-4 shadow-lg">
              <span className="block text-[15px] font-semibold text-ink">Message relays</span>
              <span className="mt-0.5 block text-[13px] text-ink/40">One extra relay per line. Each person is written to one of them, plus that person’s own inbox, so no single relay sees every conversation.</span>
              <textarea
                value={(config.lists?.dm || []).join('\n')}
                onChange={(event) => setConfig(setRelayList('dm', event.target.value))}
                spellCheck="false"
                autoComplete="off"
                rows={3}
                placeholder="One host per line"
                className="mt-3 w-full rounded-2xl border border-ink/10 bg-ink/5 px-4 py-3 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-accent"
              />
            </label>
            <label className="block rounded-2xl border border-line bg-panel p-4 shadow-lg">
              <span className="block text-[15px] font-semibold text-ink">Profile relays</span>
              <span className="mt-0.5 block text-[13px] text-ink/40">Names and relay lists only. Not messages.</span>
              <textarea
                value={(config.lists?.profile || []).join('\n')}
                onChange={(event) => setConfig(setRelayList('profile', event.target.value))}
                spellCheck="false"
                autoComplete="off"
                rows={3}
                placeholder="One host per line"
                className="mt-3 w-full rounded-2xl border border-ink/10 bg-ink/5 px-4 py-3 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-accent"
              />
            </label>
            <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
              {rows.map((row) => (
                !row.dynamic && row.called !== false ? (
                  <label key={row.id} className="block border-b border-ink/5 p-4 last:border-0">
                    <span className="block text-[15px] font-semibold text-ink">{row.role}</span>
                    <span className="mt-0.5 block break-all text-[13px] text-ink/40">{row.url || 'No default'}</span>
                    <input
                      value={row.override === 'off' ? 'off' : row.override}
                      onChange={(event) => setConfig(setRelayOverride(row.id, event.target.value))}
                      spellCheck="false"
                      autoComplete="off"
                      placeholder="Onion, your host, or off"
                      className="mt-3 w-full rounded-2xl border border-ink/10 bg-ink/5 px-4 py-3 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-accent"
                    />
                  </label>
                ) : null
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
