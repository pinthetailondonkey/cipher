import { ArrowLeft, Menu } from 'lucide-react';
import { pressable } from './Button';

// The pane's title bar. A back arrow rides only where the caller passes one
// (a pane can be drilled into from two doors). `onMenu` is the below-md
// drawer door for panes that live as tabs and so have no other way in —
// md+ never shows it; the rail and palette cover that width.
export default function ScreenHeader({ title, subtitle, onBack, onMenu }) {
  return (
    <header className="sticky top-0 z-fab flex items-center gap-2 border-b border-line bg-base px-2 py-3 shadow-lg pt-[env(safe-area-inset-top)]">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Back" className={`p-2 text-ink ${pressable}`}>
          <ArrowLeft size={22} />
        </button>
      )}
      {onMenu && (
        <button type="button" onClick={onMenu} aria-label="Open menu" className={`touch-target p-2 text-ink md:hidden ${pressable}`}>
          <Menu size={22} />
        </button>
      )}
      <div className="min-w-0 py-1 pr-3">
        <h1 className="truncate text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-ink/40">{subtitle}</p>}
      </div>
    </header>
  );
}
