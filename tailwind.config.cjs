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
        // component built on these without a code change. ink and scrim are
        // rgb triplets so Tailwind opacity modifiers (text-ink/40) compose.
        base: 'var(--bg)',
        surface: 'var(--bg-soft)',
        surfaceLight: 'var(--panel-strong)',
        panel: 'var(--panel)',
        panelStrong: 'var(--panel-strong)',
        panelAlt: 'var(--panel-alt)',
        line: 'var(--border)',
        lineStrong: 'var(--border-strong)',
        ink: 'rgb(var(--text-rgb) / <alpha-value>)',
        inkMuted: 'var(--text-muted)',
        inkSubtle: 'var(--text-subtle)',
        accent: 'var(--accent)',
        accentSoft: 'var(--accent-soft)',
        accentInk: 'var(--accent-ink)',
        success: 'var(--success)',
        danger: 'var(--danger)',
        scrim: 'rgb(var(--scrim-rgb) / <alpha-value>)',
        borderDark: 'var(--border-strong)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
