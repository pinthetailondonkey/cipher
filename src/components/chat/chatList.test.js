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
export { default as Drawer } from ${JSON.stringify(path.join(ROOT, 'src/components/chat/Drawer.jsx'))};
export { default as SearchView } from ${JSON.stringify(path.join(ROOT, 'src/components/chat/SearchView.jsx'))};
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
  const opaque = [];
  const focusables = [];
  let focusCalls = 0;
  // What a ref receives in place of a DOM node: the modal hook focuses it,
  // traps Tab inside it and gives focus back when it closes.
  const panel = {
    focus() { focusCalls += 1; },
    querySelectorAll() { return focusables; },
    contains(node) { return focusables.includes(node); },
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
    // motion.* and AnimatePresence are wrappers from outside the shim: their
    // props are read, their children are rendered, they are never called.
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

  return { render, panel, focusables, panelFocus: () => focusCalls };
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

const rowNames = (rows) => rows.map((row) => row.name);

const vendorDm = 'f'.repeat(64);
const plainDm = 'e'.repeat(64);

const seedStore = () => app.useChatStore.setState({
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

test('the segmented filter selects a real segment and filters the rows', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: null });

  let { hosts, rows } = tree.render();
  const selectionRow = hosts.find((host) => host.props.role === 'group' && host.props['aria-label'] === 'Filter chats');
  assert.ok(selectionRow, 'All / Menus / Vendors is one labelled selection row');
  assert.equal(String(selectionRow.props.className).includes('h-11'), true, 'the selection row is one compact 44px line, not a card');
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

test('one header line: the compose button starts a chat, the overflow keeps every other door', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: () => {} });

  let { hosts } = tree.render();
  assert.equal(labelledButton(hosts, 'Open menu'), undefined, 'the phone drawer door is gone from the chat header');
  assert.equal(labelledButton(hosts, 'Notifications'), undefined, 'the bell is not a second button beside the overflow');
  assert.ok(labelledButton(hosts, 'Chat list menu'), 'one overflow button on the left');
  assert.ok(labelledButton(hosts, 'New chat'), 'one compose button on the right');

  labelledButton(hosts, 'Chat list menu').props.onClick({});
  ({ hosts } = tree.render());
  for (const label of ['New group', 'New menu', 'Burn note', 'Saved messages', 'Scan QR code', 'Notifications', 'Refresh chats']) {
    assert.ok(labelledButton(hosts, label), `${label} must survive inside the overflow`);
  }
  assert.equal(labelledButton(hosts, 'Find someone'), undefined, 'no separate new-chat item competes with the compose button');

  app.useChatStore.setState({ showCreateGroup: false });
  labelledButton(hosts, 'New group').props.onClick({});
  ({ hosts } = tree.render());
  assert.equal(app.useChatStore.getState().showCreateGroup, true, 'New group opens the existing group screen');
  assert.equal(labelledButton(hosts, 'Close menu'), undefined, 'the menu and its scrim are gone once an action is picked');

  app.useChatStore.setState({ view: 'list' });
  labelledButton(hosts, 'New chat').props.onClick({});
  assert.equal(app.useChatStore.getState().view, 'search', 'the compose button opens the existing new-chat screen');
  ({ hosts } = tree.render());
  assert.equal(hosts.filter((host) => host.props.className && String(host.props.className).includes('inset-0')).length, 0, 'no scrim is left behind');
});

test('an order card in the list reads as an order, never as the word Message', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  const requestDm = 'a'.repeat(64);
  const updateDm = 'b'.repeat(64);
  app.useChatStore.setState({
    dms: {
      [requestDm]: [{ pubkey: requestDm, timestamp: 40, isSender: true, data: { type: 'order_request', product: { title: 'Blue Dream' } } }],
      // An order whose only saved row is an update — the shape the Orders tab
      // was dropping, and the one the thread still draws a card for.
      [updateDm]: [{ pubkey: updateDm, timestamp: 50, isSender: false, data: { type: 'order_update', orderId: 'order-1', status: 'paid' } }],
    },
    profiles: {
      ...app.useChatStore.getState().profiles,
      [requestDm]: { displayName: 'Order Sender', name: 'Order Sender' },
      [updateDm]: { displayName: 'Order Peer', name: 'Order Peer' },
    },
  });
  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: null });
  const { rows } = tree.render();
  const preview = (name) => rows.find((row) => row.name === name)?.previewText;
  assert.equal(preview('Order Sender'), 'Order', 'an order request reads as an order');
  assert.equal(preview('Order Peer'), 'Order', 'an order known only by its update reads as an order too');
});

test('the filter field always sits under the title and narrows the list as it is typed', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: null });

  let { hosts, rows } = tree.render();
  const field = () => hosts.find((host) => host.tag === 'input' && host.props['aria-label'] === 'Filter chats');
  assert.ok(field(), 'the filter field is on the screen without a tap');
  assert.equal(labelledButton(hosts, 'Search chats'), undefined, 'no second search control competes with the field');

  field().props.onChange({ target: { value: 'green' } });
  ({ hosts, rows } = tree.render());
  assert.deepEqual(rowNames(rows), ['Green Room'], 'typing narrows the rows');

  labelledButton(hosts, 'Clear filter').props.onClick({});
  ({ hosts, rows } = tree.render());
  assert.equal(field().props.value, '', 'the clear control empties the field');
  assert.deepEqual(rowNames(rows).sort(), ['Green Room', 'Plain Pat', 'Times Square', 'Vendor Vic'], 'the whole list comes back');
});

test('a row keeps its actions without a three-dot: a long press opens the menu', async () => {
  globalThis.window = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  seedStore();
  app.useChatStore.setState({ pinnedChats: [], archivedChats: [] });
  const tree = createTree(app.ChatList, { onOpenChat: () => {}, onRefresh: null });

  let { rows } = tree.render();
  assert.equal(rows.length, 4, 'every chat has a row');
  for (const row of rows) {
    assert.equal(row.trailing, undefined, 'no row carries a permanently visible options button');
    assert.equal(typeof row.onMenuOpen, 'function', 'the menu is still reachable from the row');
    assert.equal(typeof row.onReveal, 'function', 'the blurred preview has a reveal of its own');
  }
  assert.deepEqual(rows.map((row) => row.divider), [true, true, true, false], 'the divider runs between rows, not past the last one');

  rows[0].onPressStart();
  await new Promise((resolve) => setTimeout(resolve, 520));
  ({ rows } = tree.render());
  assert.equal(rows.filter((row) => row.menuOpen).length, 1, 'a long press opens exactly one row menu');
  const open = rows.find((row) => row.menuOpen);
  open.onMenuClose();
  ({ rows } = tree.render());
  assert.equal(rows.filter((row) => row.menuOpen).length, 0, 'closing the menu puts it away');
});

test('the new message screen says what it searches and has a submit that works', () => {
  globalThis.window = globalThis.window || { setInterval: () => 0, clearInterval: () => {} };
  seedStore();
  app.useChatStore.setState({ searchQuery: '', searchResults: [], isSearching: false });

  let searched = 0;
  const tree = createTree(app.SearchView, {
    handleSearch: () => { searched += 1; },
    joinGroupById: () => {},
    openChat: () => {},
  });
  let { hosts } = tree.render();

  const heading = hosts.find((host) => host.tag === 'h1');
  assert.equal(textOf(heading.props.children), 'New message', 'the screen is the new message screen');
  assert.ok(labelledButton(hosts, 'Back'), 'it has a way back to the list');
  const field = hosts.find((host) => host.tag === 'input');
  assert.equal(field.props.placeholder, 'Name, @handle or public key', 'the field names the three things it accepts');
  assert.equal(labelledButton(hosts, 'Search').props.disabled, true, 'submit is inert while the field is empty');

  field.props.onChange({ target: { value: 'bob' } });
  ({ hosts } = tree.render());
  assert.equal(labelledButton(hosts, 'Search').props.disabled, false, 'submit wakes up with text in the field');
  labelledButton(hosts, 'Search').props.onClick({});
  assert.equal(searched, 1, 'the submit action runs the same search Enter runs');
});

test('the phone drawer is a dialog: Escape closes it, Tab stays inside, focus comes back', () => {
  const listeners = [];
  const restored = [];
  globalThis.HTMLElement = class HTMLElement {};
  const opener = Object.assign(new globalThis.HTMLElement(), { focus() { restored.push('opener'); } });
  globalThis.window = {
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    removeEventListener: () => {},
  };
  globalThis.document = { activeElement: opener, contains: (node) => node === opener };

  let closed = 0;
  const identity = { pk: 'a'.repeat(64), npub: 'a'.repeat(64), lockApp: () => {} };
  const tree = createTree(app.Drawer, {
    identity,
    open: true,
    onClose: () => { closed += 1; },
    onNavigate: () => {},
  });
  const { opaque } = tree.render();

  const panelNode = opaque.find((node) => node.props.role === 'dialog');
  assert.ok(panelNode, 'the drawer panel is a dialog');
  assert.equal(panelNode.props['aria-modal'], 'true', 'the rest of the screen is out of reach');
  assert.equal(panelNode.props.tabIndex, -1, 'the panel can take focus');
  assert.equal(panelNode.props['aria-label'], 'Menu', 'the dialog has a name');
  assert.ok(tree.panelFocus() > 0, 'opening the drawer moves focus into it');

  const keydown = listeners.filter((entry) => entry.type === 'keydown').at(-1);
  assert.ok(keydown, 'the drawer listens for keys while it is open');
  keydown.handler({ key: 'Escape', stopPropagation() {} });
  assert.equal(closed, 1, 'Escape closes the drawer');

  let firstFocused = 0;
  const first = { focus() { firstFocused += 1; } };
  const last = { focus() {} };
  tree.focusables.push(first, last);
  globalThis.document.activeElement = last;
  let prevented = false;
  keydown.handler({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Tab at the last control stays in the drawer');
  assert.equal(firstFocused, 1, 'the wrap lands on the first control');

  app.hooks.__runCleanups();
  assert.deepEqual(restored, ['opener'], 'closing the drawer gives focus back to the control that opened it');
});
