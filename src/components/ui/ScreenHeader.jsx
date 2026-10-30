import { ArrowLeft, Menu } from 'lucide-react';
import { pressable } from './Button';

// The pane's title bar (DESIGN.md): 56px, solid --header, 1px hairline,
// title 20px. A back arrow rides only where the caller passes one (a pane
// can be drilled into from two doors). `onMenu` is the below-md drawer door
// for panes that live as tabs and so have no other way in — md+ never shows
// it; the rail and palette cover that width.
export default function ScreenHeader({ title, subtitle, onBack, onMenu, leading = null }) {
  return (
    <header className="sticky top-0 z-fab flex min-h-[56px] items-center gap-2 border-b border-line bg-header px-2 pt-[env(safe-area-inset-top)]">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Back" className={`flex min-h-[44px] min-w-[44px] items-center justify-center text-ink ${pressable}`}>
          <ArrowLeft size={22} />
        </button>
      )}
      {onMenu && (
        <button type="button" onClick={onMenu} aria-label="Open menu" className={`touch-target flex items-center justify-center p-2 text-ink md:hidden ${pressable}`}>
          <Menu size={22} />
        </button>
      )}
      {leading && <span className="shrink-0">{leading}</span>}
      <div className="min-w-0 flex-1 py-1 pr-3">
        <h1 className="truncate text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-inkMuted">{subtitle}</p>}
      </div>
    </header>
  );
}
