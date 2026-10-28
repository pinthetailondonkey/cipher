// After a deploy, a tab that was open on the old build asks for hashed files
// that no longer exist. Vite reports that as vite:preloadError; a bare
// import() that fails surfaces as a rejected promise with a browser-specific
// message. Either way the tab is stale, and the one honest thing to offer is a
// reload — said once, in plain words, with no automatic reload that could eat
// a half-typed message.
export const STALE_SHELL_WORDS = {
  message: 'A new version is ready.',
  button: 'Reload',
};

const STALE_MESSAGE = /dynamically imported module|importing a module script failed|loading chunk|loading css chunk/i;

export function isStaleShellError(reason) {
  const text = String((reason && reason.message) || reason || '');
  return STALE_MESSAGE.test(text);
}

export function installStaleShellPrompt(win) {
  let shown = false;

  function show() {
    if (shown) return;
    shown = true;
    const doc = win.document;
    const bar = doc.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.setAttribute('data-stale-shell', '');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:var(--z-toast);display:flex;gap:12px;align-items:center;justify-content:center;padding:12px 16px calc(12px + env(safe-area-inset-bottom, 0px));background:var(--panel-strong, Canvas);color:var(--text, CanvasText);font:inherit;';
    const text = doc.createElement('span');
    text.textContent = STALE_SHELL_WORDS.message;
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = STALE_SHELL_WORDS.button;
    button.style.cssText = 'min-height:44px;padding:0 18px;border:0;border-radius:10px;background:var(--accent, Highlight);color:var(--accent-ink, HighlightText);font:inherit;font-weight:700;';
    button.addEventListener('click', () => win.location.reload());
    bar.append(text, button);
    doc.body.append(bar);
  }

  win.addEventListener('vite:preloadError', show);
  win.addEventListener('unhandledrejection', (event) => {
    if (isStaleShellError(event.reason)) show();
  });
  return show;
}
