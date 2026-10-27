// Local stand-in for the PR2 badge. Superset of both landings: the unread
// pill (ChatList) rides 'unread'; row/card states take variant.
const variants = {
  unread:
    'flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accentInk',
  outline: 'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold border border-line bg-panel text-inkMuted',
  soft: 'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold bg-accentSoft text-accentText',
  solid: 'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold bg-accent text-accentInk',
};

// Small pill for counts and states that ride rows and cards. Not a button:
// nothing inside is tapped.
export default function Badge({ variant = 'unread', className = '', children, title }) {
  return (
    <span title={title} className={`${variants[variant] || variants.unread} shrink-0 ${className}`}>
      {children}
    </span>
  );
}
