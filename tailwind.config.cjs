/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Theme-aware tokens: every value reads the CSS variables set by the
        // active theme in src/index.css, so swapping data-theme re-skins any
        // component built on these without a code change.
        base: 'var(--bg)',
        surface: 'var(--bg-soft)',
        surfaceLight: 'var(--panel-strong)',
        panel: 'var(--panel)',
        panelStrong: 'var(--panel-strong)',
        panelAlt: 'var(--panel-alt)',
        line: 'var(--border)',
        lineStrong: 'var(--border-strong)',
        ink: 'var(--text)',
        inkMuted: 'var(--text-muted)',
        inkSubtle: 'var(--text-subtle)',
        accent: 'var(--accent)',
        accentSoft: 'var(--accent-soft)',
        accentInk: 'var(--accent-ink)',
        success: 'var(--success)',
        danger: 'var(--danger)',
        borderDark: 'var(--border-strong)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
