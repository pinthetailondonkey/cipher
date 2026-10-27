// Multiline field primitive: 12px label above, focus wears the accent border.
export default function Textarea({ label, className = '', ...props }) {
  const field = (
    <textarea
      className={`w-full resize-none rounded-2xl border border-line bg-panelStrong p-4 text-[15px] text-ink transition-all placeholder-ink/40 focus:border-accent focus:bg-ink/10 focus:outline-none ${className}`}
      {...props}
    />
  );
  if (!label) return field;
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-inkMuted">{label}</span>
      {field}
    </label>
  );
}
