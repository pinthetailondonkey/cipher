import { ArrowLeft, Menu } from 'lucide-react';
import { pressable } from './Button';

// The one title bar (DESIGN.md): 56px, solid --header, 1px hairline, and a
// three-slot grid — 44px, 1fr, 44px. Slot 1 is back *or* menu, slot 3 is the
// action *or* nothing, and both are always reserved so the title sits on the
// column's centre line whether or not either slot is filled. A slot that
// collapses when empty moves the title, which is the defect this grid fixes.
//
// `onBack` and `onMenu` are alternatives, not companions: a pane that can be
// drilled into gets a back arrow, a tab that needs a drawer door gets a menu.
// `leading` predates the grid and has no caller today; it still renders in
// slot 2 so an old call site keeps working. `logo` replaces the title where
// DESIGN.md puts the mark instead of a word (the Chats header, trap 3).
export default function ScreenHeader({
  title,
  subtitle,
  onBack,
  onMenu,
  action = null,
  logo = null,
  leading = null,
}) {
  return (
    <header className="sticky top-0 z-fab grid min-h-[56px] grid-cols-[44px_1fr_44px] items-center border-b border-line bg-header px-2 pt-[env(safe-area-inset-top)]">
      <div className="flex h-11 w-11 items-center justify-center">
        {onBack ? (
          <button type="button" onClick={onBack} aria-label="Back" className={`flex min-h-[44px] min-w-[44px] items-center justify-center text-ink ${pressable}`}>
            <ArrowLeft size={22} />
          </button>
        ) : onMenu ? (
          <button type="button" onClick={onMenu} aria-label="Open menu" className={`flex min-h-[44px] min-w-[44px] items-center justify-center text-ink md:hidden ${pressable}`}>
            <Menu size={22} />
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-center gap-2 py-1">
        {leading && <span className="shrink-0">{leading}</span>}
        {logo ? (
          <span className="flex shrink-0 items-center justify-center">{logo}</span>
        ) : (
          <div className="min-w-0 text-center">
            <h1 className="truncate text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="truncate text-[13px] text-inkMuted">{subtitle}</p>}
          </div>
        )}
      </div>
      <div className="flex h-11 w-11 items-center justify-center">{action}</div>
    </header>
  );
}
