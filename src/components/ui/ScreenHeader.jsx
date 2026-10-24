import { ArrowLeft } from 'lucide-react';
import { pressable } from './Button';

export default function ScreenHeader({ title, subtitle, onBack }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-1 border-b border-white/5 bg-black px-1 py-2">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Back" className={`p-2 text-white ${pressable}`}>
          <ArrowLeft size={22} />
        </button>
      )}
      <div className="min-w-0 px-2 py-1">
        <h1 className="truncate text-[17px] font-semibold text-white">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-white/40">{subtitle}</p>}
      </div>
    </header>
  );
}
