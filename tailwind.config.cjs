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
        warning: 'rgb(var(--warning-rgb) / <alpha-value>)',
        danger: 'rgb(var(--danger-rgb) / <alpha-value>)',
        // Spec names for the same palette. blue = fill, blueBright = text and
        // active icon, onBlue / onBlue2 = text on a blue fill, onDestructive
        // = text on a destructive fill.
        surface2: 'var(--surface-2)',
        pressed: 'var(--pressed)',
        separator: 'var(--separator)',
        blue: 'var(--blue)',
        blueBright: 'var(--blue-bright)',
        onBlue: 'var(--on-blue)',
        onBlue2: 'var(--on-blue-2)',
        onDestructive: 'var(--on-destructive)',
        scrim: 'rgb(var(--scrim-rgb) / <alpha-value>)',
        borderDark: 'var(--border-strong)',
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      // The spec's type roles. Sizes in px, one family, 600 for names and
      // labels. text-title for screen headings, text-name for conversation
      // and vendor names, text-section for the small uppercase labels, text-body
      // for messages and rows, text-meta for timestamps and metadata,
      // text-button for button labels.
      fontSize: {
        title: ['28px', { lineHeight: '34px', fontWeight: '600', letterSpacing: '-0.01em' }],
        name: ['15px', { lineHeight: '20px', fontWeight: '600' }],
        body: ['15px', { lineHeight: '21px' }],
        section: ['12px', { lineHeight: '16px', fontWeight: '600', letterSpacing: '0.06em' }],
        meta: ['12px', { lineHeight: '16px' }],
        button: ['15px', { lineHeight: '20px', fontWeight: '600' }],
      },
      borderRadius: {
        control: 'var(--r-control)',
        card: 'var(--r-card)',
        hero: 'var(--r-hero)',
        bubble: 'var(--r-bubble)',
        tail: 'var(--r-tail)',
      },
      spacing: {
        // Roles on the 4-point scale (values live in src/index.css).
        screen: 'var(--screen-pad)',
        card: 'var(--card-pad)',
        section: 'var(--section-gap)',
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
