import Button from './Button';

// Local stand-in for the PR2 empty state: icon in an accent-soft circle,
// title, one line, optional action (master-prompt §1).
export default function EmptyState({ icon, title, description, actionLabel, onAction, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}>
      {icon && (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accentSoft text-accentText">
          {icon}
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 text-[13px] text-inkMuted">{description}</p>}
      {actionLabel && (
        <Button className="mt-5 px-6" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
