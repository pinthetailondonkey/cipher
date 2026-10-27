import Button from './Button';

// Local stand-in for the PR2 empty state: icon in an accent-soft circle,
// title, one line, optional action. Superset of both landings: `icon` may be
// a node or a component; the line rides `description` or `children`; the
// action rides `action` (a ready node) or `actionLabel`/`onAction`. Slang
// may live in the line (copy only), never in the action.
export default function EmptyState({
  icon,
  title,
  description,
  children,
  actionLabel,
  onAction,
  action,
  className = '',
}) {
  const detail = description ?? children;
  return (
    <div
      className={`mx-4 flex flex-col items-center justify-center rounded-2xl border border-line bg-panel px-4 py-12 text-center ${className}`}
    >
      {icon && (
        <span
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accentSoft text-accentText"
          aria-hidden="true"
        >
          {typeof icon === 'function' ? <icon size={22} /> : icon}
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {detail && <p className="mt-1 max-w-[26ch] text-[13px] text-inkMuted">{detail}</p>}
      {action
        ? <div className="mt-4">{action}</div>
        : actionLabel && <Button className="mt-5 px-6" onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}
