import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// The modal reachability hook owns focus for every sheet and dialog in the
// app. The live bug it must never regress: a caller that re-renders per
// keystroke (any modal whose input state lives in the parent) used to hand
// the hook a fresh onClose identity, re-running the focus effect mid-typing;
// its panel.focus() ripped focus off the input, so the keyboard collapsed
// after one character. This test drives the hook through a real re-render
// cycle with a changing onClose identity and asserts focus moves only at
// open — and that Escape still reaches the LATEST callback.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(ROOT, 'node_modules', '.cipher-modal-test');

const REACT_SHIM = `
let current = null;
let pendingEffects = [];
let cleanups = [];

export function __addCleanup(cleanup) { cleanups.push(cleanup); }
export function __setCurrent(instance) { current = instance; current.cursor = 0; }
export function __clearCurrent() { current = null; }
export function __takeEffects() { const list = pendingEffects; pendingEffects = []; return list; }
export function __runCleanups() { const list = cleanups; cleanups = []; for (const c of list) c(); }

function nextSlot() { return current.cursor++; }

export function useState(initial) {
  const instance = current;
  const index = nextSlot();
  if (!(index in instance.slots)) {
    instance.slots[index] = typeof initial === 'function' ? initial() : initial;
  }
  const set = (value) => {
    instance.slots[index] = typeof value === 'function' ? value(instance.slots[index]) : value;
  };
  return [instance.slots[index], set];
}

export function useRef(initial) {
  const instance = current;
  const index = nextSlot();
  if (!(index in instance.slots)) instance.slots[index] = { current: initial };
  return instance.slots[index];
}

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export function useEffect(effect, deps) {
  const instance = current;
  const index = nextSlot();
  const seen = instance.effects || (instance.effects = {});
  if (index in seen && same(seen[index], deps)) return undefined;
  seen[index] = deps;
  pendingEffects.push(effect);
  return undefined;
}
`;

const ENTRY = `
export { useModalA11y } from ${JSON.stringify(path.join(ROOT, 'src/components/ui/modal.js'))};
export * as hooks from './react-shim.js';
`;

let app = null;

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'react-shim.js'), REACT_SHIM);
  fs.writeFileSync(path.join(OUT, 'entry.js'), ENTRY);
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({
    input: path.join(OUT, 'entry.js'),
    external: (id) => id !== 'react' && !id.startsWith('.') && !path.isAbsolute(id),
    platform: 'node',
    resolve: { alias: { react: path.join(OUT, 'react-shim.js') } },
  });
  await bundle.write({ dir: OUT, format: 'esm', entryFileNames: 'app.mjs', chunkFileNames: '[name]-chunk.js' });
  app = await import(`${path.join(OUT, 'app.mjs')}?v=${Date.now()}`);
});

after(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
});

// The smallest possible environment: one instance whose slots persist across
// renders (the "parent re-renders per keystroke" cycle), one panel that counts
// focus calls, one input the user is typing into, and the window the hook
// listens on.
function mountHook() {
  const instance = { slots: [], cursor: 0, effects: {} };
  class FakeHTMLElement {}
  const panel = Object.assign(new FakeHTMLElement(), { focus: () => focusLog.push('panel') });
  const input = Object.assign(new FakeHTMLElement(), { focus: () => focusLog.push('input') });
  const opener = Object.assign(new FakeHTMLElement(), { focus: () => focusLog.push('opener') });
  const focusLog = [];
  let activeElement = opener;
  const windowListeners = {};
  const savedWindow = globalThis.window;
  const savedHTMLElement = globalThis.HTMLElement;

  const render = (open, onClose) => {
    app.hooks.__setCurrent(instance);
    const panelRef = app.useModalA11y(open, onClose);
    app.hooks.__clearCurrent();
    panelRef.current = panel;
    for (const effect of app.hooks.__takeEffects()) {
      const cleanup = effect();
      if (typeof cleanup === 'function') app.hooks.__addCleanup(cleanup);
    }
    return panelRef;
  };

  const press = (key) => {
    for (const listener of [...(windowListeners.keydown || [])]) listener({ key, stopPropagation() {} });
  };

  return {
    render,
    press,
    focusLog,
    focusInput() { activeElement = input; },
    get activeElement() { return activeElement; },
    install() {
      globalThis.HTMLElement = FakeHTMLElement;
      globalThis.window = {
        addEventListener: (name, fn) => { (windowListeners[name] ||= []).push(fn); },
        removeEventListener: (name, fn) => {
          const list = windowListeners[name] || [];
          const at = list.indexOf(fn);
          if (at >= 0) list.splice(at, 1);
        },
      };
      globalThis.document = { get activeElement() { return activeElement; } };
    },
    restore() {
      globalThis.window = savedWindow;
      globalThis.HTMLElement = savedHTMLElement;
      delete globalThis.document;
    },
  };
}

test('a keystroke re-render with a fresh onClose identity does not move focus', () => {
  const m = mountHook();
  m.install();
  try {
    m.render(false, () => {});
    assert.deepEqual(m.focusLog, [], 'closed renders nothing');

    m.render(true, () => {});
    assert.deepEqual(m.focusLog, ['panel'], 'opening moves focus to the panel once');

    // The user types: focus moves to the input, and the parent re-renders
    // with a NEW inline onClose — the exact cycle of the live bug.
    m.focusInput();
    m.render(true, () => {});

    assert.deepEqual(m.focusLog, ['panel'], 'a re-render with a new onClose must not touch focus');
  } finally {
    m.restore();
  }
});

test('closing hands focus back to the opener exactly once', () => {
  const m = mountHook();
  m.install();
  try {
    m.render(true, () => {});
    m.focusInput();
    m.render(true, () => {});
    app.hooks.__runCleanups();
    assert.deepEqual(m.focusLog, ['panel', 'opener'], 'one open, one restore — no mid-open yank');
  } finally {
    m.restore();
  }
});

test('Escape reaches the latest onClose, not the one at open time', () => {
  const m = mountHook();
  m.install();
  try {
    m.render(true, () => { throw new Error('the stale callback fired'); });
    const closes = [];
    m.render(true, () => closes.push(1)); // the callback moved through the ref
    m.press('Escape');
    assert.equal(closes.length, 1, 'Escape closed through the freshest callback');
  } finally {
    m.restore();
  }
});
