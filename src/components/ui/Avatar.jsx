export default function Avatar({ src, name = '', className = '' }) {
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  if (src) {
    return <img src={src} alt="" className={`w-12 h-12 rounded-full object-cover shrink-0 ${className}`} />;
  }
  return (
    <span className={`flex w-12 h-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#111] text-[15px] font-semibold text-blue-500 ${className}`}>
      {initial}
    </span>
  );
}
