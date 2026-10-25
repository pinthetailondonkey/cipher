import { useEffect, useState } from 'react';
import { openPrivateMedia, releasePrivateMedia } from '../../lib/mediaCrypto';
import Picture from './Picture';

function usePrivateMediaUrl({ url, key, iv, mime } = {}) {
  const [state, setState] = useState({ src: '', failed: false });
  useEffect(() => {
    if (!url || !key || !iv) return undefined;
    const entry = { url, key, iv, mime };
    let live = true;
    openPrivateMedia(entry)
      .then((src) => { if (live) setState({ src, failed: false }); })
      .catch((error) => {
        console.error('[media] Could not open an attachment:', error);
        if (live) setState({ src: '', failed: true });
      });
    return () => {
      live = false;
      releasePrivateMedia(entry);
    };
  }, [url, key, iv, mime]);
  return state;
}

function PrivateImage({ entry, className }) {
  const { src, failed } = usePrivateMediaUrl(entry);
  if (failed) return <p className="text-[13px] text-white/45">Couldn't open this photo</p>;
  if (!src) return <div className={`animate-pulse bg-white/10 ${className}`} />;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block" onClick={(event) => event.stopPropagation()}>
      <img src={src} alt="Shared image" className={className} />
    </a>
  );
}

function PrivateAudio({ entry, className }) {
  const { src, failed } = usePrivateMediaUrl(entry);
  if (failed) return <p className="text-[13px] text-white/45">Couldn't open this voice note</p>;
  if (!src) return <div className={`animate-pulse rounded-full bg-white/10 ${className}`} />;
  return <audio controls preload="metadata" src={src} className={className} onClick={(event) => event.stopPropagation()} />;
}

// Picks by shape: an encrypted entry is decrypted, a pre-encryption URL is
// shown as it always was.
export function MediaImage({ item, className = '' }) {
  if (item.shape === 'private') return <PrivateImage entry={item.entry} className={className} />;
  return <Picture src={item.entry.url} link alt="Shared image" loading="lazy" className={className} />;
}

export function MediaAudio({ item, className = '' }) {
  if (item.shape === 'private') return <PrivateAudio entry={item.entry} className={className} />;
  return <audio controls preload="metadata" src={item.entry.url} className={className} onClick={(event) => event.stopPropagation()} />;
}
