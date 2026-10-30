/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Look-aware tokens: every value reads the CSS variables set once in
        // src/index.css, so the whole app re-skins with the stylesheet and no
        // component carries its own palette. ink and scrim are
        // rgb triplets so Tailwind opacity modifiers (text-ink/40) compose.
        base: 'var(--bg)',
        surface: 'var(--bg-soft)',
        surfaceLight: 'var(--panel-strong)',
        panel: 'var(--panel)',
        panelStrong: 'var(--panel-strong)',
        panelAlt: 'var(--panel-alt)',
        header: 'var(--header)',
        bubbleIn: 'var(--bubble-in)',
        bubbleOut: 'var(--bubble-out)',
        line: 'var(--border)',
        lineStrong: 'var(--border-strong)',
        ink: 'rgb(var(--text-rgb) / <alpha-value>)',
        inkMuted: 'var(--text-muted)',
        inkSubtle: 'var(--text-subtle)',
        accent: 'var(--accent)',
        accentText: 'var(--accent-text)',
        accentSoft: 'var(--accent-soft)',
        accentInk: 'var(--accent-ink)',
        success: 'rgb(var(--success-rgb) / <alpha-value>)',
        danger: 'rgb(var(--danger-rgb) / <alpha-value>)',
        scrim: 'rgb(var(--scrim-rgb) / <alpha-value>)',
        borderDark: 'var(--border-strong)',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      zIndex: {
        // Layer tokens live in one place: the CSS variables in src/index.css.
        fab: 'var(--z-fab)',
        sheet: 'var(--z-sheet)',
        call: 'var(--z-call)',
        toast: 'var(--z-toast)',
      }
    },
  },
  plugins: [],
}
