// One look, one mark: the raw logo on every surface. (The per-theme marks
// went with the theme registry.) Both axes are pinned inline because
// Tailwind's preflight sets `img { height: auto }`: the raw mark is 237x256,
// so size 28 rendered 30 tall. DESIGN.md names the mark's size.
export default function Logo({ size = 32, className = '' }) {
  return (
    <img
      src="/logo_raw.png?v=3"
      alt="Cipher Logo"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`object-contain ${className}`}
      draggable={false}
    />
  );
}
