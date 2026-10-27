import { pictureIsGated, pictureHost } from '../../lib/pictureGate.js';

export function useVisibleSrc(src) {
  return String(src || '').trim();
}

export default function Picture({ src, link = false, fallback = null, onClick, ...props }) {
  const shown = useVisibleSrc(src);
  if (!shown) return fallback;
  if (pictureIsGated(shown)) {
    const host = pictureHost(shown);
    const label = `This picture comes from ${host}. Opening it shows that site your address.`;
    const className = props.className || '';
    return (
      <a
        href={shown}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        title={label}
        className={`block shrink-0 overflow-hidden rounded-xl border border-ink/10 bg-scrim/30 ${className}`}
        onClick={(event) => { event.stopPropagation(); onClick?.(event); }}
      >
        <span className="flex w-full items-center justify-center p-2 text-center text-[12px] leading-snug text-ink/50">
          {label}
        </span>
      </a>
    );
  }
  const image = <img src={shown} {...props} />;
  if (!link) return image;
  return (
    <a href={shown} target="_blank" rel="noreferrer" className="block" onClick={(event) => { event.stopPropagation(); onClick?.(event); }}>
      {image}
    </a>
  );
}
