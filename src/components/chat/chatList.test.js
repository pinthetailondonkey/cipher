import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// The chat list's segmented filter has to be exercised through the real
// component: the labels are built in ChatList and the active fill and the
// click handler live in Segmented, so a helper test cannot see whether the
// two agree. This file bundles both with the project's own bundler and runs
// them against a hooks shim that renders a tree, so a click is a click.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(ROOT, 'node_modules', '.cipher-chatlist-test');

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

export function useMemo(factory, deps) {
  const instance = current;
  const index = nextSlot();
  const held = instance.slots[index];
  if (!held || !same(held.deps, deps)) instance.slots[index] = { deps, value: factory() };
  return instance.slots[index].value;
}

export function useCallback(callback, deps) {
  return useMemo(() => callback, deps);
}

export function useEffect(effect, deps) {
  const instance = current;
  const index = nextSlot();
  if (instance.mounted) return undefined;
  if (!deps || deps.length === 0) pendingEffects.push(effect);
  return undefined;
}

export function useLayoutEffect(effect, deps) { return useEffect(effect, deps); }
export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
export function useContext() { return undefined; }
export function createContext(defaultValue) { return { Provider: ({ children }) => children, _default: defaultValue }; }
export function useReducer(reducer, initial) {
  const [state, set] = useState(initial);
  return [state, (action) => set((prev) => reducer(prev, action))];
}
export function useId() { return 'id'; }
export function useImperativeHandle() {}
export function useDebugValue() {}
export function memo(component) { return component; }
export function forwardRef(component) { return function Forwarded(props) { return component(props, null); }; }
export function isValidElement(value) { return Boolean(value) && typeof value === 'object' && 'type' in value; }
export function cloneElement(element, props) { return { type: element.type, props: { ...element.props, ...props } }; }
export function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length > 1 ? children : children[0] } };
}
export function Children() {}
export const Fragment = Symbol.for('react.fragment');

const React = {
  useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect,
  useSyncExternalStore, useContext, createContext, useReducer, useId,
  useImperativeHandle, useDebugValue, memo, forwardRef, isValidElement,
  cloneElement, createElement, Children, Fragment,
};
export default React;
`;

const JSX_SHIM = `
export const Fragment = Symbol.for('react.fragment');
export function jsx(type, props) { return { type, props: props || {} }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
`;

const ENTRY = `
export { default as ChatList } from ${JSON.stringify(path.join(ROOT, 'src/components/chat/ChatList.jsx'))};
export { useChatStore } from ${JSON.stringify(path.join(ROOT, 'src/store/chatStore.js'))};
export * as hooks from './react-shim.js';
`;

// The store reads its selectors through zustand's own useCallback, so zustand
// has to come through the shim too or the shimmed hooks are bypassed.
const isShimmed = (id) => id === 'react' || id === 'react/jsx-runtime' || id === 'zustand' || id.startsWith('zustand/');

let app = null;

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'react-shim.js'), REACT_SHIM);
  fs.writeFileSync(path.join(OUT, 'jsx-shim.js'), JSX_SHIM);
  fs.writeFileSync(path.join(OUT, 'entry.js'), ENTRY);

  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({
    input: path.join(OUT, 'entry.js'),
    external: (id) => !isShimmed(id) && !id.startsWith('.') && !path.isAbsolute(id),
    platform: 'node',
    resolve: {
      alias: {
        react: path.join(OUT, 'react-shim.js'),
        'react/jsx-runtime': path.join(OUT, 'jsx-shim.js'),
      },
    },
  });
  await bundle.write({ dir: OUT, format: 'esm', entryFileNames: 'app.mjs', chunkFileNames: '[name]-chunk.js' });
  app = await import(`${path.join(OUT, 'app.mjs')}?v=${Date.now()}`);
});

after(() => {
  if (process.env.CHATLIST_KEEP_BUNDLE) return;
  fs.rmSync(OUT, { recursive: true, force: true });
});

// The smallest tree runner that can hold a component's hook slots across
// re-renders. ChatRow is a leaf: the rows themselves are what the filter
// decides, so its props are the assertion surface.
function createTree(component, props) {
  const instances = new Map();
  const hosts = [];
  const rows = [];

  const walk = (node, at) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${at}.${index}`));
      return;
    }
    if (typeof node !== 'object') return;
    const { type, props: ownProps = {} } = node;
    if (type === app.hooks.default?.Fragment || type === Symbol.for('react.fragment')) {
      walk(ownProps.children, at);
      return;
    }
    if (typeof type === 'string') {
      const host = { tag: type, props: ownProps };
      hosts.push(host);
      walk(ownProps.children, `${at}/${type}`);
      return;
    }
    if (typeof type !== 'function') return;
    if (type.name === 'ChatRow') {
      rows.push(ownProps);
      return;
    }
    const instance = instances.get(at) || { slots: [], cursor: 0, mounted: false };
    instances.set(at, instance);
    app.hooks.__setCurrent(instance);
    const output = type(ownProps);
    app.hooks.__clearCurrent();
    walk(output, `${at}/${type.name}`);
    instance.mounted = true;
    for (const effect of app.hooks.__takeEffects()) effect();
  };

  const render = () => {
    hosts.length = 0;
    rows.length = 0;
    walk({ type: component, props }, 'root');
    return { hosts, rows };
  };

  return { render };
}

const labelledButton = (hosts, label) => hosts.find(
  (host) => host.tag === 'button' && (host.props.children === label || host.props['aria-label'] === label)
);

const rowNames = (rows) => rows.map((row) => row.name);

test('the segmented filter selects a real segment and filters the rows', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  const vendorDm = 'f'.repeat(64);
  const plainDm = 'e'.repeat(64);
  app.useChatStore.setState({
    dms: {
      [vendorDm]: [{ pubkey: vendorDm, timestamp: 30, data: { message: 'order please', type: 'order_request' } }],
      [plainDm]: [{ pubkey: plainDm, timestamp: 20, data: { message: 'hello' } }],
    },
    groups: [
      { id: 'green', name: 'Green Room', isChannel: true },
      { id: 'square', name: 'Times Square', isChannel: false },
    ],
    profiles: {
      [vendorDm]: { displayName: 'Vendor Vic', name: 'Vendor Vic' },
      [plainDm]: { displayName: 'Plain Pat', name: 'Plain Pat' },
    },
    archivedChats: [],
    pinnedChats: [],
    blockedUsers: [],
    mutedChats: [],
    mutedUntil: {},
    unreadCounts: {},
    typingUsers: {},
    loading: false,
  });

  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: null });

  let { hosts, rows } = tree.render();
  assert.equal(labelledButton(hosts, 'All').props['aria-pressed'], true, 'All starts selected');
  assert.equal(labelledButton(hosts, 'Menus').props['aria-pressed'], false, 'Menus is not selected yet');
  assert.deepEqual(rowNames(rows).sort(), ['Green Room', 'Plain Pat', 'Times Square', 'Vendor Vic'], 'All shows every chat');

  labelledButton(hosts, 'Menus').props.onClick({});
  ({ hosts, rows } = tree.render());
  assert.equal(labelledButton(hosts, 'Menus').props['aria-pressed'], true, 'the click selects Menus');
  assert.equal(labelledButton(hosts, 'All').props['aria-pressed'], false, 'All lets go of the fill');
  assert.deepEqual(rowNames(rows), ['Green Room'], 'Menus shows channels only');

  labelledButton(hosts, 'Vendors').props.onClick({});
  ({ hosts, rows } = tree.render());
  assert.equal(labelledButton(hosts, 'Vendors').props['aria-pressed'], true, 'the click selects Vendors');
  assert.deepEqual(rowNames(rows), ['Vendor Vic'], 'Vendors shows chats where commerce happened');

  labelledButton(hosts, 'All').props.onClick({});
  ({ hosts, rows } = tree.render());
  assert.equal(labelledButton(hosts, 'All').props['aria-pressed'], true, 'All takes the fill back');
  assert.deepEqual(rowNames(rows).sort(), ['Green Room', 'Plain Pat', 'Times Square', 'Vendor Vic'], 'All restores the whole list');
});
