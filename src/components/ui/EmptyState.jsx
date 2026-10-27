<<<<<<< HEAD
import Button from './Button';

// Empty state — idle list copy. Icon sits in an accent-soft circle, one
// title, one line, optional action. Superset of the landings in flight:
// `icon` may be a node or a component; the line rides `description` or
// `children`; the action rides `action` (a ready node) or
// `actionLabel`/`onAction`. Slang may live in the line (copy only), never in
// the action.
export default function EmptyState({
  icon = null,
  title,
  description,
  children,
  actionLabel,
  onAction,
  action = null,
  className = '',
}) {
  const detail = description ?? children;
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}>
      {icon ? (
        <span
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accentSoft text-accentText"
          aria-hidden="true"
        >
          {typeof icon === 'function' ? <icon size={22} /> : icon}
        </span>
      ) : null}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {detail ? <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-inkMuted">{detail}</p> : null}
      {action ? (
        <div className="mt-4">{action}</div>
      ) : actionLabel ? (
        <Button className="mt-4 px-6" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
=======
// The idle screen: icon in the accent-soft circle, one title, one line, and
// the one action the user should take next. Slang may flavor this copy.
export default function EmptyState({ icon = null, title, line = null, action = null, className = '' }) {
  return (
    <div className={`flex flex-col items-center rounded-2xl border border-line bg-panel px-6 py-12 text-center ${className}`}>
      {icon && (
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accentSoft text-accentText">
          {icon}
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {line && <p className="mt-1 max-w-[16rem] text-[13px] text-inkMuted">{line}</p>}
      {action && <div className="mt-5">{action}</div>}
>>>>>>> origin/feat/rebuild-pr2
    </div>
  );
}
