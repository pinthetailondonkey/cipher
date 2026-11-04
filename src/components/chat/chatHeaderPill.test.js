import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// The DM header's Order pill is a jump, not a page. This file holds it to
// the light through the real component, bundled and rendered with the same
// shim the chat list's tests use, so the derivation behind the pill's
// visibility and the press that fires the scroll are both read off the
// rendered tree — the way vite will render them.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(ROOT, 'node_modules', '.cipher-chatheader-pill-test');

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
  if (!instance) return undefined;
  const index = nextSlot();
  const seen = instance.effects || (instance.effects = {});
  if (!(index in seen)) {
    seen[index] = true;
    pendingEffects.push(effect);
  }
  return undefined;
}

function useEffectReal(effect) {
  pendingEffects.push(effect);
  return undefined;
}

export function __runCleanups() {
  const list = cleanups;
  cleanups = [];
  for (const cleanup of list) cleanup();
}

export function useLayoutEffect(effect) { return useEffectReal(effect); }
export function useInsertionEffect(effect) { return useEffectReal(effect); }
export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
export function useContext(context) { return context?._default; }
export function useTransition() { return [false, (fn) => fn()]; }
export function useDeferredValue(value) { return value; }
export function Component() {}
Component.prototype.isReactComponent = {};
export function PureComponent() {}
PureComponent.prototype = Object.create(Component.prototype);
PureComponent.prototype.isReactComponent = {};
export function createContext(defaultValue) { return { Provider: ({ children }) => children, _default: defaultValue }; }
export function useReducer(reducer, initial) {
  const [state, set] = useState(initial);
  return [state, (action) => set((prev) => reducer(prev, action))];
}
export function useId() { return 'id'; }
export function useImperativeHandle() {}
export function useDebugValue() {}
export function memo(component) { return component; }
export function forwardRef(component) {
  return { $$typeof: Symbol.for('react.forward_ref'), render: component };
}
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
export { default as ChatHeader, payableOrderAnchorOf } from ${JSON.stringify(path.join(ROOT, 'src/components/chat/ChatHeader.jsx'))};
export { useChatStore } from ${JSON.stringify(path.join(ROOT, 'src/store/chatStore.js'))};
export * as hooks from './react-shim.js';
`;

// zustand comes through the shim for the same reason the chat list tests
// give: its selectors are read through its own hook plumbing, and framer-
// motion imports react itself, so left external it would bind the real
// react's dispatcher, which no shimmed hook sets.
const isShimmed = (id) => id === 'react' || id === 'react/jsx-runtime' || id === 'zustand' || id.startsWith('zustand/');
const isBundled = (id) => isShimmed(id) || /^(framer-motion|motion-dom|motion-utils)(\/|$)/.test(id);

let app = null;

before(async () => {
  globalThis.localStorage = {
    disk: new Map(),
    getItem(key) { return this.disk.has(key) ? this.disk.get(key) : null; },
    setItem(key, value) { this.disk.set(key, String(value)); },
    removeItem(key) { this.disk.delete(key); },
    clear() { this.disk.clear(); },
  };
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'react-shim.js'), REACT_SHIM);
  fs.writeFileSync(path.join(OUT, 'jsx-shim.js'), JSX_SHIM);
  // The safety sheet portals to document.body; the shim tree is not a
  // browser, so the portal passes its children straight through.
  fs.writeFileSync(path.join(OUT, 'react-dom-shim.js'), 'export const createPortal = (children) => children;\n');
  fs.writeFileSync(path.join(OUT, 'entry.js'), ENTRY);

  const alias = {
    react: path.join(OUT, 'react-shim.js'),
    'react/jsx-runtime': path.join(OUT, 'jsx-shim.js'),
    'react-dom': path.join(OUT, 'react-dom-shim.js'),
  };
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({
    input: path.join(OUT, 'entry.js'),
    external: (id) => !isBundled(id) && !alias[id] && !id.startsWith('.') && !path.isAbsolute(id),
    platform: 'node',
    resolve: { alias },
  });
  await bundle.write({ dir: OUT, format: 'esm', entryFileNames: 'app.mjs', chunkFileNames: '[name]-chunk.js' });
  app = await import(`${path.join(OUT, 'app.mjs')}?v=${Date.now()}`);
});

after(() => {
  // Every render queues the header's effects; the last one leaves the
  // now-ticker interval holding the process open. Run the collected
  // cleanups before tearing the bundle down.
  try { app?.hooks?.__runCleanups(); } catch { /* nothing mounted yet */ }
  if (process.env.CHATHEADER_KEEP_BUNDLE) return;
  fs.rmSync(OUT, { recursive: true, force: true });
});

// The smallest tree runner: hook slots held across renders, hosts collected.
// The pill is a leaf button whose onClick is the assertion surface.
function createTree(component, props) {
  const instances = new Map();
  const hosts = [];
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
    // An icon or a portal wrapper is an object outside the shim: its props
    // are read and it is never called.
    if (typeof type !== 'function' || type.name === 'AnimatePresence') {
      opaque.push({ type, props: ownProps });
      if (ownProps.ref && typeof ownProps.ref === 'object' && 'current' in ownProps.ref) ownProps.ref.current = panel;
      walk(ownProps.children, at);
      return;
    }
    const instance = instances.get(at) || { slots: [], cursor: 0, mounted: false, effects: {} };
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
    opaque.length = 0;
    walk({ type: component, props }, 'root');
    return { hosts, opaque };
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

const BUYER = 'a'.repeat(64);
const VENDOR = 'b'.repeat(64);
const BTC_ADDR = 'bc1qexampleaddress0000000000000000000000000000';

const seedStore = ({ dms = {}, view = null, activeDm = null } = {}) => app.useChatStore.setState({
  dms, view, activeDm,
  activeGroup: null,
  groups: [],
  groupMessages: {},
  profiles: {
    [VENDOR]: { displayName: 'Vendor Vic', name: 'Vendor Vic' },
  },
  unreadCounts: {},
  typingUsers: {},
  groupTypingUsers: {},
  disappearingTimers: {},
  loading: false,
});

const request = {
  id: 'req-1',
  pubkey: BUYER,
  isSender: true,
  timestamp: 100,
  data: { type: 'cipher_order', status: 'pending', product: { title: 'Flower' } },
};

// The acceptance fixture. The order thread needs three ids to agree — the
// message's own `id`, its place in time (`ts`) and its card fields — so
// they are named arguments rather than one spread that could drop one of
// them onto the wrong level of the object.
const acceptance = ({ topId = 'upd-1', ts = 200, ...card } = {}) => ({
  id: topId,
  pubkey: VENDOR,
  isSender: false,
  timestamp: ts,
  data: {
    type: 'order_update', orderId: 'req-1',
    status: 'accepted',
    paymentState: 'address_issued',
    coinCurrency: 'btc', coinAmount: '0.00020000',
    paymentMethods: { btc: BTC_ADDR },
    ...card,
  },
});

test('an accepted order with an issued address yields its acceptance card', () => {
  assert.equal(app.payableOrderAnchorOf([request, acceptance()])?.id, 'upd-1');
});

test('the newest address-bearing update wins over an older one', () => {
  // A re-issued pair may move the anchor forward; a later update without a
  // pair never displaces the one that carries the address.
  const older = acceptance();
  const reissued = acceptance({ topId: 'upd-2', ts: 300, paymentMethods: { btc: 'bc1qnewerexampleaddress000000000000000000' } });
  assert.equal(app.payableOrderAnchorOf([request, older, reissued])?.id, 'upd-2');
  const pairless = acceptance({ topId: 'upd-3', ts: 400, paymentMethods: {} });
  assert.equal(app.payableOrderAnchorOf([request, older, reissued, pairless])?.id, 'upd-2');
});

test('paid stays payable: the pill survives past the payment mark', () => {
  const paidUpdate = acceptance({
    topId: 'upd-3', ts: 300,
    status: 'paid', paymentSeenBy: 'vendor',
  });
  assert.equal(app.payableOrderAnchorOf([request, acceptance(), paidUpdate])?.id, 'upd-3');
});

test('seen-on-chain rides the evidence layer through the request card patch', () => {
  // The buyer's own watcher check lands as a localPatch on their own card —
  // exactly what the ledger and the order card already read.
  const watched = { ...request, localPatch: { paymentState: 'seen' } };
  assert.equal(app.payableOrderAnchorOf([watched, acceptance()])?.id, 'upd-1');
});

test('a pending order takes no pill: no address was ever issued', () => {
  assert.equal(app.payableOrderAnchorOf([request]), null);
});

test('shipped, completed, cancelled, refunded and disputed take no pill', () => {
  const paidUpdate = acceptance({ topId: 'upd-3', ts: 300, status: 'paid', paymentSeenBy: 'vendor' });
  for (const [status, over] of [
    ['shipped', { paymentState: 'confirmed', paymentSeenBy: 'watcher' }],
    ['completed', {}],
    ['cancelled', {}],
    ['refunded', {}],
    ['disputed', {}],
  ]) {
    const close = acceptance({ topId: `close-${status}`, ts: 400, status, ...over });
    assert.equal(app.payableOrderAnchorOf([request, acceptance(), paidUpdate, close]), null, status);
  }
});

test('a peer-typed currency this device does not trade anchors nothing', () => {
  // '__proto__' resolves on any object keyed lookup would build elsewhere;
  // the asset table refuses it here so no phantom anchor can render.
  const fake = acceptance({
    topId: 'upd-proto', ts: 250,
    coinCurrency: '__proto__',
    paymentMethods: {},
  });
  assert.equal(app.payableOrderAnchorOf([request, fake]), null);
});

test('empty addresses are not an issuance: the pair must carry one', () => {
  assert.equal(app.payableOrderAnchorOf([request, acceptance({ paymentMethods: { btc: '' } })]), null);
});

test('no thread, an untyped one, or nothing passed: no anchor, no throw', () => {
  assert.equal(app.payableOrderAnchorOf(null), null);
  assert.equal(app.payableOrderAnchorOf([]), null);
  assert.equal(app.payableOrderAnchorOf([{ id: 'm1', data: { type: 'text', message: 'hi' } }]), null);
});

test('the DM header shows the Order pill only while the deal is payable, and the press jumps', () => {
  globalThis.window = { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => 0, clearTimeout: () => {}, addEventListener() {}, removeEventListener() {} };
  const jumps = [];
  globalThis.document = {
    body: { style: {} },
    activeElement: null,
    getElementById: (id) => (jumps.push(id), {
      scrollIntoView() {}, classList: { remove() {}, add() {} }, offsetWidth: 1,
    }),
  };

  // Payable: accepted with an issued address — the pill is there.
  seedStore({ dms: { [VENDOR]: [request, acceptance()] }, view: 'dm', activeDm: VENDOR });
  let tree = createTree(app.ChatHeader, { mode: 'dm' });
  let { hosts } = tree.render();
  const pill = labelledButton(hosts, 'Jump to the order payment card');
  assert.ok(pill, 'the payable deal puts the Order pill in the header');
  assert.equal(textOf(pill.props.children).trim(), 'Order', 'the pill says Order');
  const jumpsBefore = jumps.length;
  pill.props.onClick({});
  assert.equal(jumps.length, jumpsBefore + 1, 'the press fired the jump');
  assert.equal(jumps.at(-1), 'msg-upd-1', 'the jump names the latest issued card');

  // Closed deal: completed updates came after — no pill.
  seedStore({
    dms: {
      [VENDOR]: [
        request, acceptance(),
        acceptance({ topId: 'upd-close', ts: 400, status: 'completed', paymentState: 'confirmed' }),
      ],
    },
    view: 'dm', activeDm: VENDOR,
  });
  tree = createTree(app.ChatHeader, { mode: 'dm' });
  ({ hosts } = tree.render());
  assert.equal(labelledButton(hosts, 'Jump to the order payment card'), undefined, 'the closed deal carries no pill');

  // Group mode: the pill is a DM thing and never fires there.
  seedStore({ dms: { [VENDOR]: [request, acceptance()] }, view: 'group', activeDm: null });
  app.useChatStore.setState({ activeGroup: { id: 'g1', name: 'Green Room' } });
  tree = createTree(app.ChatHeader, { mode: 'group' });
  ({ hosts } = tree.render());
  assert.equal(labelledButton(hosts, 'Jump to the order payment card'), undefined, 'the group header carries no Order pill');

  delete globalThis.document;
});
