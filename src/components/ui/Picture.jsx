export function useVisibleSrc(src) {
  return String(src || '').trim();
}

export default function Picture({ src, link = false, fallback = null, onClick, ...props }) {
  const shown = useVisibleSrc(src);
  if (!shown) return fallback;
  const image = <img src={shown} {...props} />;
  if (!link) return image;
  return (
    <a href={shown} target="_blank" rel="noreferrer" className="block" onClick={(event) => { event.stopPropagation(); onClick?.(event); }}>
      {image}
    </a>
  );
}
