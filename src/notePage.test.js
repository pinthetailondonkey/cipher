import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// The burn-note reader's whole point is that it is reachable with NO account,
// and the failure it must never repeat is the one the founder hit: a stranger
// with a note link gets the lock screen. A helper test cannot see that — the
// gate lives in App.jsx, ahead of two identity returns — so this file bundles
// the real App with only its neighbours stubbed, renders it at /note, and
// reads the tree.
//
// What is stubbed, and why each one cannot hide the defect:
//   ./useIdentity    — returns no session key. That IS the stranger.
//   ./LockScreen     — renders the word the real screen opens with (asserted
//                      below from the real file), so its absence is meaningful.
//   ./AuthenticatedApp — a marker, so "the app opened" is visible, not inferred.
//   ./lib/noteReader — the network half. The gate is not the network.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(ROOT, 'node_modules', '.cipher-notepage-test');

const REACT_SHIM = `
let current = null;
let pendingEffects = [];

export function __setCurrent(instance) { current = instance; current.cursor = 0; }
export function __clearCurrent() { current = null; }
export function __takeEffects() { const list = pendingEffects; pendingEffects = []; return list; }
function nextSlot() { return current.cursor++; }

export function useState(initial) {
  const instance = current;
  const index = nextSlot();
  if (!(index in instance.slots)) instance.slots[index] = typeof initial === 'function' ? initial() : initial;
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
export function useMemo(factory, deps) {
  const instance = current;
  const index = nextSlot();
  const held = instance.slots[index];
  if (!held || !same(held.deps, deps)) instance.slots[index] = { deps, value: factory() };
  return instance.slots[index].value;
}
export function useCallback(callback, deps) { return useMemo(() => callback, deps); }
export function useEffect(effect, deps) {
  const instance = current;
  const index = nextSlot();
  const seen = instance.effects || (instance.effects = {});
  if (index in seen && same(seen[index], deps)) return undefined;
  seen[index] = deps;
  pendingEffects.push(effect);
  return undefined;
}
export function useLayoutEffect(effect, deps) { return useEffect(effect, deps); }
export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
export function useContext() { return undefined; }
export function createContext(defaultValue) { return { Provider: ({ children }) => children, _default: defaultValue }; }
export function memo(component) { return component; }
export function lazy(loader) {
  const Lazy = () => null;
  Lazy.loader = loader;
  return Lazy;
}
export function Suspense({ children }) { return children; }
export function createElement(type, props, ...children) {
  const out = { ...(props || {}) };
  // A stub may pass children as a prop (createElement('h1', { children: 'x' }));
  // only a positional child is allowed to overwrite it.
  if (children.length) out.children = children.length > 1 ? children : children[0];
  return { type, props: out };
}
export const Fragment = Symbol.for('react.fragment');
export class Component {
  constructor(props) { this.props = props; this.state = {}; }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; }
}
export class PureComponent extends Component {}
const React = {
  useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect, useSyncExternalStore,
  useContext, createContext, memo, lazy, Suspense, createElement, Fragment, Component, PureComponent,
};
export default React;
`;

const JSX_SHIM = `
export const Fragment = Symbol.for('react.fragment');
export function jsx(type, props) { return { type, props: props || {} }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
`;

const STUBS = {
  './useIdentity': `
export function useIdentity() {
  return { sk: null, pk: null, loadingSession: false, unlock: () => {} };
}
`,
  './LockScreen': `
import { createElement } from './react-shim.js';
export default function LockScreen() {
  return createElement('h1', { children: 'Unlock Cipher' });
}
`,
  './AuthenticatedApp': `
import { createElement } from './react-shim.js';
export default function AuthenticatedApp() {
  return createElement('p', { children: 'Welcome to Cipher' });
}
`,
  './store/chatStore': `
const state = { panicWipeEnabled: false };
export const useChatStore = (selector) => (typeof selector === 'function' ? selector(state) : state);
useChatStore.getState = () => state;
useChatStore.setState = (next) => Object.assign(state, next);
`,
  './hooks/usePanicWipe': `
export function usePanicWipe() {}
`,
  './lib/noteReader': `
export async function openNoteLink({ fragment }) {
  const answer = globalThis.__noteAnswer || { ok: true, text: 'meet at the usual place', transport: 'relay' };
  if (!answer.ok) throw new Error(answer.message);
  return { text: answer.text, transport: answer.transport, fragment };
}
`,
};

const FRAMER_SHIM = `
export function MotionConfig({ children }) { return children; }
export function AnimatePresence({ children }) { return children; }
export const motion = new Proxy({}, { get: () => ({ children }) => children });
`;

const ENTRY = `
export { default as App } from ${JSON.stringify(path.join(SRC, 'App.jsx'))};
export * as hooks from './react-shim.js';
`;

let app = null;
let calls = 0;

const stubFor = (id) => (id in STUBS ? path.join(OUT, `stub-${id.replace(/[^a-z0-9]/gi, '_')}.js`) : null);

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'react-shim.js'), REACT_SHIM);
  fs.writeFileSync(path.join(OUT, 'jsx-shim.js'), JSX_SHIM);
  fs.writeFileSync(path.join(OUT, 'framer-shim.js'), FRAMER_SHIM);
  fs.writeFileSync(path.join(OUT, 'entry.js'), ENTRY);
  for (const [id, source] of Object.entries(STUBS)) {
    fs.writeFileSync(stubFor(id), source);
  }

  const { rolldown } = await import('rolldown');
  // Aliases are matched on the specifier exactly as written, so these are the
  // same strings App.jsx imports. Each stub replaces a neighbour that would
  // otherwise need a real device (a vault, a database, the network); nothing
  // that decides the gate is stubbed.
  const alias = {
    react: path.join(OUT, 'react-shim.js'),
    'react/jsx-runtime': path.join(OUT, 'jsx-shim.js'),
    'framer-motion': path.join(OUT, 'framer-shim.js'),
  };
  for (const id of Object.keys(STUBS)) alias[id] = stubFor(id);
  const bundle = await rolldown({
    input: path.join(OUT, 'entry.js'),
    platform: 'node',
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id) && !(id in alias),
    resolve: { alias },
  });
  calls = 0;
  await bundle.write({ dir: OUT, format: 'esm', entryFileNames: 'app.mjs', chunkFileNames: '[name]-chunk.js' });
  app = await import(`${path.join(OUT, 'app.mjs')}?v=${Date.now()}`);
});

after(() => {
  if (process.env.NOTEPAGE_KEEP_BUNDLE) return;
  fs.rmSync(OUT, { recursive: true, force: true });
});

// The smallest tree runner that holds a component's hook slots across
// re-renders. Same shape as the chat list's runner: a class component is
// mounted once (App's ErrorBoundary), a function component per path.
function createTree(component, props) {
  const instances = new Map();
  const classes = new Map();
  const hosts = [];

  const walk = (node, at) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') return;
    if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${at}.${index}`)); return; }
    if (typeof node !== 'object') return;
    const { type, props: ownProps = {} } = node;
    if (type === Symbol.for('react.fragment')) { walk(ownProps.children, at); return; }
    if (typeof type === 'string') { hosts.push({ tag: type, props: ownProps }); walk(ownProps.children, `${at}/${type}`); return; }
    if (typeof type === 'function' && type.prototype && type.prototype.setState) {
      const instance = classes.get(at) || new type(ownProps);
      classes.set(at, instance);
      instance.props = ownProps;
      walk(instance.render(), `${at}/${type.name}`);
      return;
    }
    if (typeof type !== 'function') { walk(ownProps.children, at); return; }
    const instance = instances.get(at) || { slots: [], cursor: 0 };
    instances.set(at, instance);
    app.hooks.__setCurrent(instance);
    const output = type(ownProps);
    app.hooks.__clearCurrent();
    walk(output, `${at}/${type.name}`);
    for (const effect of app.hooks.__takeEffects()) effect();
  };

  const render = () => { hosts.length = 0; walk({ type: component, props }, 'root'); return { hosts }; };
  return { render };
}

const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
};

const screenText = (hosts) => hosts.map((host) => textOf(host.props.children)).join(' | ');

const setRoute = ({ pathname, hash, replaced = [] }) => {
  globalThis.window = {
    location: { pathname, hash, search: '' },
    history: { replaceState: (_state, _title, url) => { replaced.push(String(url)); } },
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    dispatchEvent() {},
  };
  globalThis.document = {
    title: 'Cipher',
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {} }),
    execCommand: () => true,
    queryCommandSupported: () => true,
  };
  return replaced;
};

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); };

test('a note link opens on a device with no vault: the note text, never the lock screen', async () => {
  // The stub's word is the real screen's word — prove it rather than assume it.
  const lockSource = fs.readFileSync(path.join(SRC, 'LockScreen.jsx'), 'utf8');
  assert.match(lockSource, /Unlock Cipher/, 'the stub speaks the lock screen\'s own opening words');

  globalThis.__noteAnswer = { ok: true, text: 'meet at the usual place', transport: 'relay' };
  const replaced = setRoute({ pathname: '/note', hash: '#AAAA' });
  const tree = createTree(app.App, {});
  tree.render();
  await settle();
  const { hosts } = tree.render();
  const text = screenText(hosts);

  assert.match(text, /meet at the usual place/, 'the note text is on the screen');
  assert.doesNotMatch(text, /Unlock Cipher/, 'a stranger with a link never meets the lock screen');
  assert.doesNotMatch(text, /Welcome to Cipher/, 'the account app never opens for a note link');
  assert.equal(globalThis.__noteAnswer.transport === 'relay' && text.includes('This note opens once on this device'), true,
    'the relay path says what is true of it: one open on this device');
  assert.doesNotMatch(text, /gone from the server/i, 'the relay path never claims the server deleted it');
  assert.deepEqual(replaced.slice(-1), ['/note'], 'the fragment is cleared from the address bar after the text is on screen');
});

test('a note already opened on this device says so, in the words the reader already uses', async () => {
  globalThis.__noteAnswer = { ok: false, message: 'This note was already opened on this device.' };
  const replaced = setRoute({ pathname: '/note', hash: '#BBBB' });
  const tree = createTree(app.App, {});
  tree.render();
  await settle();
  const { hosts } = tree.render();
  const text = screenText(hosts);
  assert.match(text, /This note was already opened on this device\./, 'the second open says what happened');
  assert.doesNotMatch(text, /Unlock Cipher/);
  assert.deepEqual(replaced, [], 'a note that never opened leaves the link in the address bar');
});

test('a plain app launch is untouched: no note route, the lock screen is what a stranger gets', async () => {
  setRoute({ pathname: '/', hash: '' });
  const tree = createTree(app.App, {});
  const { hosts } = tree.render();
  const text = screenText(hosts);
  assert.match(text, /Unlock Cipher/, 'outside /note the gate is exactly as it was');
  assert.doesNotMatch(text, /A note that reads once/);
});
