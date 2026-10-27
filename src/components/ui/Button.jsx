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
};

export const pressable = 'active:scale-95 transition-transform duration-100';

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leadingIcon = null,
  trailingIcon = null,
  fullWidth = false,
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
    </button>
  );
}
