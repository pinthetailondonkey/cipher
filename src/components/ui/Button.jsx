<<<<<<< HEAD
// Button — the one scaled control. Variants: primary (accent fill),
// secondary (panel-strong + border), ghost (text only), danger.
// Sizes: sm 36 / md 44 / lg 52. Composes around existing handlers only.
const variants = {
  primary: 'bg-accent hover:bg-accent active:bg-accent text-accentInk hover:opacity-90',
  secondary: 'border border-line bg-panelStrong shadow-lg text-ink hover:opacity-90',
  ghost: 'bg-transparent text-accentText hover:opacity-80',
  danger: 'bg-danger hover:bg-danger active:opacity-90 text-ink',
};

const sizes = {
  sm: 'min-h-[36px] px-3.5 py-2 text-[13px] gap-1.5',
  md: 'min-h-[44px] px-4 py-2.5 text-[14px] gap-2',
  lg: 'min-h-[52px] px-5 py-3.5 text-[15px] gap-2',
=======
import { Loader2 } from 'lucide-react';

// Keep the shared pressable scale util here: screens import it from this
// module so one press treatment covers every button in the app.
export const pressable = 'active:scale-[0.98] transition-transform duration-100';

const variants = {
  primary: 'bg-accent hover:bg-accent text-accentInk shadow-lg',
  secondary: 'border border-line bg-panelStrong text-ink hover:bg-ink/5 shadow-lg',
  ghost: 'bg-transparent text-ink hover:bg-ink/5',
  danger: 'bg-danger text-accentInk hover:bg-danger/90',
>>>>>>> origin/feat/rebuild-pr2
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
<<<<<<< HEAD
  className = '',
  type = 'button',
  disabled,
  children,
  ...props
}) {
  const still = disabled || loading;
  return (
    <button
      type={type}
      disabled={still}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center rounded-2xl font-bold ${pressable} ${variants[variant] || variants.primary} ${sizes[size] || sizes.md} ${fullWidth ? 'w-full' : ''} disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (leadingIcon || trailingIcon ? (
        <>
          {leadingIcon && <span className="inline-flex shrink-0 [&>svg]:block">{leadingIcon}</span>}
          <span className="min-w-0 truncate">{children}</span>
          {trailingIcon && <span className="inline-flex shrink-0 [&>svg]:block">{trailingIcon}</span>}
        </>
      ) : children)}
=======
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
>>>>>>> origin/feat/rebuild-pr2
    </button>
  );
}
