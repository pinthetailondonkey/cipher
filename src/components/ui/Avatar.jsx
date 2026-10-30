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
  const shown = useVisibleSrc(src);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  const scale = SIZES[size] || SIZES.md;
  const textSize = size === 'row' ? 'text-[20px]' : size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-[12px]' : 'text-[15px]';
  if (shown) {
    return <img src={shown} alt="" className={`${scale} rounded-full object-cover shrink-0 ${className}`} />;
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
