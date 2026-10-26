export default function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full rounded-2xl border border-line bg-panelStrong p-4 text-[15px] text-ink transition-all placeholder-ink/40 focus:border-accent focus:bg-ink/10 focus:outline-none ${className}`}
      {...props}
    />
  );
}
