import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// The refresh item in the chat list menu used to be a dead control: it
// called the fetch with no argument, closed its own menu, and nothing on
// the screen ever said the press had done anything. This file holds that
// to the light through the real component, bundled and rendered with the
// same shim the segmented-filter test uses, so a click is a click and the
// spinning arrow is read off the rendered tree.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(ROOT, 'node_modules', '.cipher-chatlist-refresh-test');

const REACT_SHIM = `
let current = null;
let pendingEffects = [];
let cleanups = [];

export function __addCleanup(cleanup) { cleanups.push(cleanup); }
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
  const seen = instance.effects || (instance.effects = {});
  if (index in seen && same(seen[index], deps)) return undefined;
  seen[index] = deps;
  pendingEffects.push(effect);
  return undefined;
}

export function __runCleanups() {
  const list = cleanups;
  cleanups = [];
  for (const cleanup of list) cleanup();
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
  if (process.env.CHATLIST_REFRESH_KEEP_BUNDLE) return;
  fs.rmSync(OUT, { recursive: true, force: true });
});

// The same tree runner the chat list's other tests use: it holds a
// component's hook slots across re-renders, so a click that sets state can
// be read back out of the next render.
function createTree(component, props) {
  const instances = new Map();
  const hosts = [];
  const rows = [];
  const opaque = [];
  let focusCalls = 0;
  const panel = {
    focus() { focusCalls += 1; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };

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
    // An icon from outside the shim is an object, not a function: its props
    // are read and it is never called. The spinning arrow is one of these.
    if (typeof type !== 'function' || type.name === 'AnimatePresence') {
      opaque.push({ type, props: ownProps });
      if (ownProps.ref && typeof ownProps.ref === 'object' && 'current' in ownProps.ref) ownProps.ref.current = panel;
      walk(ownProps.children, at);
      return;
    }
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
    for (const effect of app.hooks.__takeEffects()) {
      const cleanup = effect();
      if (typeof cleanup === 'function') app.hooks.__addCleanup(cleanup);
    }
  };

  const render = () => {
    hosts.length = 0;
    rows.length = 0;
    opaque.length = 0;
    walk({ type: component, props }, 'root');
    return { hosts, rows, opaque };
  };

  return { render, panelFocus: () => focusCalls };
}

const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
};

const labelledButton = (hosts, label) => hosts.find(
  (host) => host.tag === 'button' && (textOf(host.props.children) === label || host.props['aria-label'] === label)
);

const seedStore = () => app.useChatStore.setState({
  dms: {
    ['f'.repeat(64)]: [{ pubkey: 'f'.repeat(64), timestamp: 30, data: { message: 'order please', type: 'order_request' } }],
  },
  groups: [
    { id: 'green', name: 'Green Room', isChannel: true },
  ],
  profiles: {
    ['f'.repeat(64)]: { displayName: 'Vendor Vic', name: 'Vendor Vic' },
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

test('refresh answers the press: the arrow spins while the fetch runs and the menu closes when it settles', async () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  let resolveFetch;
  const running = new Promise((resolve) => { resolveFetch = resolve; });
  let presses = 0;
  const tree = createTree(app.ChatList, {
    onOpenChat: () => {},
    onRefresh: () => { presses += 1; return running; },
  });

  let { hosts, opaque } = tree.render();
  labelledButton(hosts, 'Chat list menu').props.onClick({});
  ({ hosts, opaque } = tree.render());
  const refreshItem = labelledButton(hosts, 'Refresh chats');
  assert.ok(refreshItem, 'the refresh item is in the open menu');
  const spinning = () => opaque.some((node) => String(node.props?.className || '').includes('animate-spin'));
  assert.equal(spinning(), false, 'the arrow is still before the press');

  const press = refreshItem.props.onClick({});
  await Promise.resolve();
  ({ hosts, opaque } = tree.render());
  assert.equal(presses, 1, 'the press ran the fetch');
  assert.equal(spinning(), true, 'the arrow spins while the fetch runs');
  assert.ok(labelledButton(hosts, 'Refresh chats'), 'the menu stays open so the spinning arrow stays on screen');

  labelledButton(hosts, 'Refresh chats').props.onClick({});
  await Promise.resolve();
  assert.equal(presses, 1, 'a second press while one fetch runs starts no second fetch');

  resolveFetch();
  await press;
  ({ hosts, opaque } = tree.render());
  assert.equal(spinning(), false, 'the arrow stops when the fetch settles');
  assert.equal(labelledButton(hosts, 'Refresh chats'), undefined, 'the menu closes once the fetch has answered');
});

test('a rejected fetch still answers the press: the spinner stops and the menu closes', async () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  // The rejected promise is marked handled at its own creation so node does
  // not call it unhandled: the item under test still receives a rejection
  // and must answer it by stopping the spinner and closing the menu.
  const boom = Promise.reject(new Error('relay is gone'));
  boom.catch(() => {});
  const tree = createTree(app.ChatList, {
    onOpenChat: () => {},
    onRefresh: () => boom,
  });

  let { hosts } = tree.render();
  labelledButton(hosts, 'Chat list menu').props.onClick({});
  ({ hosts } = tree.render());
  const press = labelledButton(hosts, 'Refresh chats').props.onClick({});
  await press;
  const { hosts: after, opaque } = tree.render();
  assert.equal(
    opaque.some((node) => String(node.props?.className || '').includes('animate-spin')),
    false,
    'the arrow stops even when the fetch fails',
  );
  assert.equal(labelledButton(after, 'Refresh chats'), undefined, 'the menu closes on failure too');
});

test('with no fetch wired there is no refresh item to press', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: null });
  let { hosts } = tree.render();
  labelledButton(hosts, 'Chat list menu').props.onClick({});
  ({ hosts } = tree.render());
  assert.equal(labelledButton(hosts, 'Refresh chats'), undefined, 'the door is absent rather than a silent no-op');
});
