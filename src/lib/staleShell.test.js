import assert from 'node:assert/strict';
import test from 'node:test';
import { STALE_SHELL_WORDS, installStaleShellPrompt, isStaleShellError } from './staleShell.js';

function fakeWindow() {
  const listeners = {};
  const appended = [];
  let reloads = 0;
  const el = (tag) => ({
    tag, attrs: {}, style: {}, children: [], listeners: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    append(...kids) { this.children.push(...kids); },
  });
  return {
    win: {
      document: { createElement: el, body: { append: (node) => appended.push(node) } },
      location: { reload: () => { reloads += 1; } },
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    listeners, appended, reloads: () => reloads,
  };
}

test('the browser messages for a missing chunk read as a stale shell, other errors do not', () => {
  assert.ok(isStaleShellError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js')));
  assert.ok(isStaleShellError(new Error('error loading dynamically imported module')));
  assert.ok(isStaleShellError(new TypeError('Importing a module script failed.')));
  assert.ok(isStaleShellError(new Error('Loading chunk 12 failed.')));
  assert.ok(!isStaleShellError(new Error('Network request failed')));
  assert.ok(!isStaleShellError(undefined));
});

test('vite:preloadError shows the prompt once, with the plain words and a reload button', () => {
  const f = fakeWindow();
  installStaleShellPrompt(f.win);
  f.listeners['vite:preloadError']({});
  f.listeners['vite:preloadError']({});
  assert.equal(f.appended.length, 1);
  const bar = f.appended[0];
  assert.equal(bar.attrs.role, 'alert');
  assert.equal(bar.children[0].textContent, STALE_SHELL_WORDS.message);
  assert.equal(bar.children[1].textContent, STALE_SHELL_WORDS.button);
  assert.equal(f.reloads(), 0, 'nothing reloads by itself');
  bar.children[1].listeners.click();
  assert.equal(f.reloads(), 1);
});

test('a rejected dynamic import shows the prompt; an unrelated rejection does not', () => {
  const f = fakeWindow();
  installStaleShellPrompt(f.win);
  f.listeners.unhandledrejection({ reason: new Error('something else') });
  assert.equal(f.appended.length, 0);
  f.listeners.unhandledrejection({ reason: new TypeError('Failed to fetch dynamically imported module: /assets/x.js') });
  assert.equal(f.appended.length, 1);
});
