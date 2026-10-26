// Appearance themes: one CSS variable set per theme in src/index.css, applied
// by setting data-theme on <html>. Components built on the theme tokens
// (tailwind colors base/panel/line/ink/accent/... and the var-driven shell
// classes) re-skin without any code change. The list here is the only place
// a new theme needs registering beyond its variable block.
const KEY = 'cipher_theme';

export const THEMES = [
  { id: 'vault', name: 'Vault', blurb: 'Pure black, blue accent' },
  { id: 'lobby', name: 'Bank lobby', blurb: 'Charcoal panels, brass accent' },
  { id: 'chromerooms', name: 'Chrome Rooms', blurb: 'Cold steel, silver accent' },
];

const KNOWN = THEMES.map((theme) => theme.id);

export function currentTheme() {
  try {
    const saved = globalThis.localStorage.getItem(KEY);
    return KNOWN.includes(saved) ? saved : 'vault';
  } catch {
    return 'vault';
  }
}

export function setTheme(id) {
  if (!KNOWN.includes(id)) return;
  try { globalThis.localStorage.setItem(KEY, id); } catch {}
  document.documentElement.dataset.theme = id;
}

// Runs once at boot, before the first paint of any themed surface.
export function applySavedTheme() {
  document.documentElement.dataset.theme = currentTheme();
}
