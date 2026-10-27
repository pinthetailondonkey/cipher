import { useEffect, useState } from 'react';
import { openPrivateMedia, releasePrivateMedia } from '../../lib/mediaCrypto';
import { pictureHost, pictureIsGated } from '../../lib/pictureGate.js';
import Picture from './Picture';

// The gate rule for every byte: a plain-browser build (no chosen route)
// refuses to make the fetch itself — openPrivateMedia is where that fetch
// lives, so the gate sits before it. A deliberate tap stays available: the
// tap passes the gate and the attachment opens for a viewer who was named
// the host and chose to be counted (docs/NO-IP-LEAKS.md). Onion hosts and
// the desktop shell (bundled Tor) open freely.
function gateBox({ src, className, label, onTap }) {
  const host = pictureHost(src) || 'an outside host';
  return (
    <button
      type="button"
      className={`block shrink-0 overflow-hidden rounded-xl border border-ink/10 bg-scrim/30 px-2 py-3 text-left text-[12px] leading-snug text-ink/50 ${className}`}
      onClick={(event) => { event.stopPropagation(); onTap(); }}
      title={label}
    >
      {label}
    </button>
  );
}

function usePrivateMediaUrl({ url, key, iv, mime } = {}) {
  const [state, setState] = useState({ src: '', failed: false, gated: false });
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    if (!url || !key || !iv) return undefined;
    if (pictureIsGated(url) && !unlocked) {
      setState({ src: '', failed: false, gated: true });
      return undefined;
    }
    const entry = { url, key, iv, mime };
    let live = true;
    openPrivateMedia(entry)
      .then((src) => { if (live) setState({ src, failed: false, gated: false }); })
      .catch((error) => {
        console.error('[media] Could not open an attachment:', error);
        if (live) setState({ src: '', failed: true, gated: false });
      });
    return () => {
      live = false;
      releasePrivateMedia(entry);
    };
  }, [url, key, iv, mime, unlocked]);
  const open = () => setUnlocked(true);
  return { state, open };
}

function PrivateImage({ entry, className }) {
  const { state, open } = usePrivateMediaUrl(entry);
  if (state.gated) {
    const label = `This attachment lives on ${pictureHost(entry.url) || 'an outside host'}. Opening it tells that host your address.`;
    return gateBox({ src: entry.url, className, label, onTap: open });
  }
  if (state.failed) return <p className="text-[13px] text-ink/45">Couldn't open this photo</p>;
  if (!state.src) return <div className={`animate-pulse bg-ink/10 ${className}`} />;
  return (
    <a href={state.src} target="_blank" rel="noreferrer" className="block" onClick={(event) => event.stopPropagation()}>
      <img src={state.src} alt="Shared image" className={className} />
    </a>
  );
}

function PrivateAudio({ entry, className }) {
  const { state, open } = usePrivateMediaUrl(entry);
  if (state.gated) {
    const label = `This voice note lives on ${pictureHost(entry.url) || 'an outside host'}. Opening it tells that host your address.`;
    return gateBox({ src: entry.url, className, label, onTap: open });
  }
  if (state.failed) return <p className="text-[13px] text-ink/45">Couldn't open this voice note</p>;
  if (!state.src) return <div className={`animate-pulse rounded-full bg-ink/10 ${className}`} />;
  return <audio controls preload="metadata" src={state.src} className={className} onClick={(event) => event.stopPropagation()} />;
}

// Picks by shape: an encrypted entry is decrypted, a pre-encryption URL is
// shown as it always was.
export function MediaImage({ item, className = '' }) {
  if (item.shape === 'private') return <PrivateImage entry={item.entry} className={className} />;
  return <Picture src={item.entry.url} link alt="Shared image" loading="lazy" className={className} />;
}

export function MediaAudio({ item, className = '' }) {
  const [unlocked, setUnlocked] = useState(false);
  if (item.shape === 'private') return <PrivateAudio entry={item.entry} className={className} />;
  // A public audio file with preload="metadata" would fetch before any tap,
  // so the gate holds the element until it is asked for by a tap.
  if (pictureIsGated(item.entry.url) && !unlocked) {
    const label = `This voice note lives on ${pictureHost(item.entry.url) || 'an outside host'}. Opening it tells that host your address.`;
    return gateBox({ src: item.entry.url, className, label, onTap: () => setUnlocked(true) });
  }
  return <audio controls preload="metadata" src={item.entry.url} className={className} onClick={(event) => event.stopPropagation()} />;
}
