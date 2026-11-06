import { useEffect, useState } from 'react';
import { isPrivateMedia, openPrivateMedia, releasePrivateMedia } from '../../lib/mediaCrypto';
import { MEDIA_REFERRER_POLICY, mediaHostOf } from '../../lib/mediaUrl';
import { useVisibleSrc } from './Picture';

// Identity at a glance (DESIGN.md): a deterministic two-tone gradient keyed
// by the pubkey's first character — 7 pairs, index = charCodeAt(0) % 7 —
// with the initial in white. Photos still win when a real src is set.
// Tokens only — no literal colours anywhere in the component.
const PAIRS = [
  ['var(--accent)', 'var(--accent-text)'],
  ['var(--panel-alt)', 'var(--accent)'],
  ['var(--accent-text)', 'var(--accent)'],
  ['var(--panel-alt)', 'var(--accent-text)'],
  ['var(--accent)', 'var(--panel-strong)'],
  ['var(--panel)', 'var(--panel-alt)'],
  ['var(--panel-strong)', 'var(--accent)'],
];

const SIZES = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  row: 'h-[52px] w-[52px]',
  lg: 'h-14 w-14',
};

export default function Avatar({ src, name = '', pubkey = '', size = 'md', className = '' }) {
  // N1: an encrypted avatar resolves like any other attachment — fetched,
  // decrypted, held open while rendered, released after. A plain URL string
  // draws exactly as before. The gradient initial covers both the empty case
  // and a decryption that failed, so a broken photo degrades to identity,
  // never to a hole.
  const [privateSrc, setPrivateSrc] = useState('');
  const privateEntry = isPrivateMedia(src) ? src : null;
  useEffect(() => {
    if (!privateEntry) return undefined;
    let live = true;
    const entry = { url: privateEntry.url, key: privateEntry.key, iv: privateEntry.iv, mime: privateEntry.mime };
    openPrivateMedia(entry)
      .then((resolved) => { if (live) setPrivateSrc(resolved); })
      .catch((error) => {
        console.error('[avatar] Could not open the picture:', error);
        if (live) setPrivateSrc('');
      });
    return () => {
      live = false;
      releasePrivateMedia(entry);
      setPrivateSrc('');
    };
  }, [privateEntry?.url, privateEntry?.key, privateEntry?.iv]);

  const shown = useVisibleSrc(privateEntry ? privateSrc : src);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  const scale = SIZES[size] || SIZES.md;
  const textSize = size === 'row' ? 'text-[20px]' : size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-[12px]' : 'text-[15px]';
  if (shown) {
    // The host rides a tooltip, when the face came off a host rather than out
    // of a local blob URL.
    const host = mediaHostOf(shown);
    return (
      <img
        src={shown}
        alt=""
        referrerPolicy={MEDIA_REFERRER_POLICY}
        title={host || undefined}
        className={`${scale} rounded-full object-cover shrink-0 ${className}`}
      />
    );
  }
  const key = pubkey || name || '?';
  const [from, to] = PAIRS[key.charCodeAt(0) % PAIRS.length];
  return (
    <span
      className={`flex ${scale} shrink-0 items-center justify-center rounded-full font-semibold text-white ${textSize} ${className}`}
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
