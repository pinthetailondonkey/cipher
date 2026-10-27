import { useVisibleSrc } from './Picture';

<<<<<<< HEAD
// Avatar — one circular mark. `size` overrides the pixel size (44 for
// sheet headers, 40 for rows); the existing 48 default keeps older screens
// untouched until the shared pass resets it.
export default function Avatar({ src, name = '', size = 48, className = '' }) {
  const shown = useVisibleSrc(src);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  const box = { width: size, height: size };
  const fontSize = Math.max(11, Math.round(size * 0.32));
  if (shown) {
    return (
      <img
        src={shown}
        alt=""
        style={box}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <span
      style={{ ...box, fontSize: `${fontSize}px` }}
      className={`flex shrink-0 items-center justify-center rounded-full border border-line bg-panelStrong shadow-lg font-semibold text-accent ${className}`}
=======
// The 40px round identity by default. No story rings, no presence dot —
// cipher is lean. Bigger callers pass a className override.
const SIZES = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-14 w-14',
};

export default function Avatar({ src, name = '', size = 'md', className = '' }) {
  const shown = useVisibleSrc(src);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  const scale = SIZES[size] || SIZES.md;
  const roundedSize = size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-[12px]' : 'text-[15px]';
  if (shown) {
    return <img src={shown} alt="" className={`${scale} rounded-full object-cover shrink-0 ${className}`} />;
  }
  return (
    <span
      className={`flex ${scale} shrink-0 items-center justify-center rounded-full border border-line bg-panelStrong shadow-lg font-semibold text-accent ${roundedSize} ${className}`}
>>>>>>> origin/feat/rebuild-pr2
    >
      {initial}
    </span>
  );
}
