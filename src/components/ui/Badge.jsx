const variants = {
  outline: 'border border-line bg-panel text-inkMuted',
  soft: 'bg-accentSoft text-accentText',
  solid: 'bg-accent text-accentInk',
};

// Small pill for counts and states that ride rows and cards. Not a button:
// nothing inside is tapped.
export default function Badge({ variant = 'outline', className = '', children }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${variants[variant] || variants.outline} ${className}`}>
      {children}
    </span>
  );
}
