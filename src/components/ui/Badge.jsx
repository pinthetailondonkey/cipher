// Local stand-in for the PR2 badge: the accent unread pill.
export default function Badge({ children, className = '', title }) {
  return (
    <span
      title={title}
      className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accentInk ${className}`}
    >
      {children}
    </span>
  );
}
