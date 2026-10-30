import { Loader2 } from 'lucide-react';

// Keep the shared pressable scale util here: screens import it from this
// module so one press treatment covers every button in the app.
export const pressable = 'active:scale-[0.98] transition-transform duration-100';

// DESIGN.md: one solid primary per view; everything else is soft (accent
// tint with accent text) or ghost. `secondary` stays as a name for the soft
// tier so screens built against it do not turn into second primaries.
const variants = {
  primary: 'bg-accent text-accentInk hover:bg-accent/90',
  soft: 'bg-accentSoft text-accentText hover:bg-accentSoft/80',
  secondary: 'bg-accentSoft text-accentText hover:bg-accentSoft/80',
  ghost: 'bg-transparent text-ink hover:bg-ink/5',
  danger: 'bg-danger text-accentInk hover:bg-danger/90',
};

const sizes = {
  sm: 'min-h-[36px] gap-1.5 px-4 py-1.5 text-[13px]',
  md: 'min-h-[44px] gap-2 px-5 py-2.5 text-[15px]',
  lg: 'min-h-[52px] gap-2 px-6 py-3.5 text-[15px]',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leadingIcon = null,
  trailingIcon = null,
  fullWidth = false,
  disabled = false,
  className = '',
  type = 'button',
  children,
  ...props
}) {
  const idle = disabled || loading;
  return (
    <button
      type={type}
      disabled={idle}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center rounded-2xl font-bold disabled:cursor-not-allowed disabled:opacity-50 ${pressable} ${variants[variant] || variants.primary} ${sizes[size] || sizes.md} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {loading
        ? <Loader2 size={16} className="shrink-0 animate-spin" aria-hidden="true" />
        : (leadingIcon && typeof leadingIcon !== 'string'
          ? <span className="shrink-0" aria-hidden="true">{leadingIcon}</span>
          : leadingIcon)}
      <span className="truncate">{children}</span>
      {!loading && trailingIcon && typeof trailingIcon !== 'string'
        ? <span className="shrink-0" aria-hidden="true">{trailingIcon}</span>
        : null}
    </button>
  );
}
