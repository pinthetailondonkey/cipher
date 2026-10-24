export default function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50 ${className}`}
      {...props}
    />
  );
}
