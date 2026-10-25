import { useEffect, useState } from 'react';
import { openPrivateMedia } from '../../lib/mediaCrypto';

function usePrivateMediaUrl({ url, key, iv, mime } = {}) {
  const [state, setState] = useState({ src: '', failed: false });
  useEffect(() => {
    if (!url || !key || !iv) return undefined;
    let live = true;
    openPrivateMedia({ url, key, iv, mime })
      .then((src) => { if (live) setState({ src, failed: false }); })
      .catch((error) => {
        console.error('[media] Could not open an attachment:', error);
        if (live) setState({ src: '', failed: true });
      });
    return () => { live = false; };
  }, [url, key, iv, mime]);
  return state;
}

export function PrivateImage({ entry, className = '' }) {
  const { src, failed } = usePrivateMediaUrl(entry);
  if (failed) return <p className="text-[13px] text-white/45">Couldn't open this photo</p>;
  if (!src) return <div className={`animate-pulse bg-white/10 ${className}`} />;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block" onClick={(event) => event.stopPropagation()}>
      <img src={src} alt="Shared image" className={className} />
    </a>
  );
}

export function PrivateAudio({ entry, className = '' }) {
  const { src, failed } = usePrivateMediaUrl(entry);
  if (failed) return <p className="text-[13px] text-white/45">Couldn't open this voice note</p>;
  if (!src) return <div className={`animate-pulse rounded-full bg-white/10 ${className}`} />;
  return <audio controls preload="metadata" src={src} className={className} onClick={(event) => event.stopPropagation()} />;
}
