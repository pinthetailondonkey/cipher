import { ArrowLeft } from 'lucide-react';
import { pressable } from './Button';

export default function ScreenHeader({ title, subtitle, onBack }) {
  return (
    <header className="sticky top-0 z-fab flex items-center gap-2 border-b border-line bg-base px-2 py-3 shadow-lg pt-[env(safe-area-inset-top)]">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Back" className={`p-2 text-ink ${pressable}`}>
          <ArrowLeft size={22} />
        </button>
      )}
      <div className="min-w-0 py-1 pr-3">
        <h1 className="truncate text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-ink/40">{subtitle}</p>}
      </div>
    </header>
  );
}
