const variants = {
  primary: 'bg-accent hover:bg-accent active:bg-accent text-accentInk',
  secondary: 'border border-line bg-panelStrong shadow-lg text-ink active:bg-ink/10',
  danger: 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-ink',
};

export const pressable = 'active:scale-95 transition-transform duration-100';

export default function Button({ variant = 'primary', className = '', type = 'button', children, ...props }) {
  return (
    <button
      type={type}
      className={`rounded-2xl py-3.5 font-bold disabled:cursor-not-allowed disabled:opacity-50 ${pressable} ${variants[variant] || variants.primary} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
