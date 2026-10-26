import { useVisibleSrc } from './Picture';

export default function Avatar({ src, name = '', className = '' }) {
  const shown = useVisibleSrc(src);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  if (shown) {
    return <img src={shown} alt="" className={`w-12 h-12 rounded-full object-cover shrink-0 ${className}`} />;
  }
  return (
    <span className={`flex w-12 h-12 shrink-0 items-center justify-center rounded-full border border-line bg-panelStrong shadow-lg text-[15px] font-semibold text-accent ${className}`}>
      {initial}
    </span>
  );
}
