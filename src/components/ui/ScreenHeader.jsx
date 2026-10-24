import { ArrowLeft } from 'lucide-react';
import { pressable } from './Button';

export default function ScreenHeader({ title, subtitle, onBack }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-[#0A0A0A]/60 px-2 py-3 shadow-2xl backdrop-blur-2xl">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Back" className={`p-2 text-white ${pressable}`}>
          <ArrowLeft size={22} />
        </button>
      )}
      <div className="min-w-0 py-1 pr-3">
        <h1 className="truncate text-2xl font-bold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-white/40">{subtitle}</p>}
      </div>
    </header>
  );
}
