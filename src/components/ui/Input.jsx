export default function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full rounded-2xl border border-white/10 bg-white/5 p-4 text-[15px] text-white backdrop-blur-md transition-all placeholder-white/40 focus:border-blue-500 focus:bg-white/10 focus:outline-none ${className}`}
      {...props}
    />
  );
}
