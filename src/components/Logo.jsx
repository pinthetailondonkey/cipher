// One look, one mark: the raw logo on every surface. (The per-theme marks
// went with the theme registry.)
export default function Logo({ size = 32, className = '' }) {
  return (
    <img
      src="/logo_raw.png?v=3"
      alt="Cipher Logo"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      draggable={false}
    />
  );
}
