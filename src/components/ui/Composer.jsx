import { Mic, Plus, SendHorizonal } from 'lucide-react';
import { forwardRef } from 'react';

// The message composer (DESIGN.md): a floating pill, "+" on the left, and
// mic / send that swap on the right as the field gains or empties a
// character. Safe-area aware so the pill clears the home indicator.
const Composer = forwardRef(function Composer(
  { value = '', onChange, onSend, onMic = null, onPlus = null, placeholder = 'Message', className = '', ...props },
  ref,
) {
  const hasText = value.trim().length > 0;
  return (
    <div
      className={`flex items-end gap-2 px-3 ${className}`}
      style={{ paddingBottom: 'calc(var(--sab, 0px) + 8px)' }}
    >
      <button
        type="button"
        onClick={onPlus}
        aria-label="More"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panelAlt text-ink active:bg-ink/10"
      >
        <Plus size={20} aria-hidden="true" />
      </button>
      <div className="flex min-h-[44px] min-w-0 flex-1 items-center rounded-full bg-panelAlt px-4">
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent py-2.5 text-[16px] text-ink outline-none placeholder:text-inkMuted"
          {...props}
        />
      </div>
      {hasText ? (
        <button
          type="button"
          onClick={onSend}
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accentInk active:bg-accent/90"
        >
          <SendHorizonal size={19} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onMic}
          aria-label="Record a voice message"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panelAlt text-ink active:bg-ink/10"
        >
          <Mic size={20} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

export default Composer;
