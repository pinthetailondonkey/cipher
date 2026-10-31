import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// The Profile row "How to use" opens a full screen with the founder's guide,
// not the after-signup sheet. The sheet's door is the chat store's
// showTutorial flag (AuthenticatedApp renders TutorialModal from it), so the
// witness is behavioural: click the real row in the real Wallet and read what
// the tap raised. On a tree where the row still opens the sheet, the click
// sets that flag and no guide text renders — both assertions below go red.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(ROOT, 'node_modules', '.cipher-howto-test');

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
  for (const c of list) c();
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
export function lazy(ctor) { return { $$cipherLazy: ctor }; }
export function Suspense(props) { return props.children; }
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

// Wallet uploads photos through Blossom; the witness never uploads, and the
// real package would pull the Nostr stack into the bundle for nothing.
const BLOSSOM_STUB = `
export async function uploadToBlossom() {
  throw new Error('blossom is not reachable in this test');
}
`;

const ENTRY = `
export { default as Wallet } from ${JSON.stringify(path.join(ROOT, 'src/Wallet.jsx'))};
export { useChatStore } from ${JSON.stringify(path.join(ROOT, 'src/store/chatStore.js'))};
export * as hooks from './react-shim.js';
`;

// The store reads its selectors through zustand's own hooks, so zustand has
// to come through the shim too or the shimmed hooks are bypassed.
const isShimmed = (id) => id === 'react' || id === 'react/jsx-runtime' || id === 'zustand' || id.startsWith('zustand/');

let app = null;

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'react-shim.js'), REACT_SHIM);
  fs.writeFileSync(path.join(OUT, 'jsx-shim.js'), JSX_SHIM);
  fs.writeFileSync(path.join(OUT, 'blossom-stub.js'), BLOSSOM_STUB);
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
        '@nostr-wot/blossom': path.join(OUT, 'blossom-stub.js'),
      },
    },
  });
  await bundle.write({ dir: OUT, format: 'esm', entryFileNames: 'app.mjs', chunkFileNames: '[name]-chunk.js' });
  app = await import(`${path.join(OUT, 'app.mjs')}?v=${Date.now()}`);
});

after(() => {
  if (process.env.HOWTO_KEEP_BUNDLE) return;
  fs.rmSync(OUT, { recursive: true, force: true });
});

// The chatList tree runner, trimmed to what this witness reads: string tags
// become hosts, function components render through the hooks shim so a click
// re-renders with the same slot state, wrappers from outside the shim are
// walked but never called.
function createTree(component, props) {
  const instances = new Map();
  const hosts = [];

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
      hosts.push({ tag: type, props: ownProps });
      walk(ownProps.children, `${at}/${type}`);
      return;
    }
    if (typeof type !== 'function' || type.name === 'AnimatePresence') {
      walk(ownProps.children, at);
      return;
    }
    const instance = instances.get(at) || { slots: [], cursor: 0 };
    instances.set(at, instance);
    app.hooks.__setCurrent(instance);
    const output = type(ownProps);
    app.hooks.__clearCurrent();
    walk(output, `${at}/${type.name}`);
    for (const effect of app.hooks.__takeEffects()) {
      const cleanup = effect();
      if (typeof cleanup === 'function') app.hooks.__addCleanup(cleanup);
    }
  };

  const render = () => {
    hosts.length = 0;
    walk({ type: component, props }, 'root');
    return { hosts };
  };

  return { render };
}

const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
};

// Wallet reads window timers and localStorage at mount (status toasts, the
// payment-address seed). Node 20 has neither global, so the witness supplies
// inert versions before the first render.
const stubBrowserGlobals = () => {
  globalThis.window = globalThis.window || {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear(),
    };
  }
};

test('the How to use row opens the full-screen guide', () => {
  stubBrowserGlobals();
  app.useChatStore.setState({ showTutorial: false });
  // A short pubkey keeps the profile read local: the stub database answers
  // and no relay fetch is attempted from a unit test.
  const identity = { pk: 'test', npub: 'np1testaccount', lockApp() {}, panicWipe() {} };
  const tree = createTree(app.Wallet, { identity, onOpenChat: () => {} });

  let { hosts } = tree.render();
  const row = hosts.find((host) => host.tag === 'button' && textOf(host.props.children).includes('How to use'));
  assert.ok(row, 'the Profile menu keeps its How to use row as a button');

  row.props.onClick({});
  ({ hosts } = tree.render());
  const text = hosts.map((host) => textOf(host.props.children)).join('\n');
  assert.ok(text.includes('Welcome to Cipher'), 'the tap opens the guide screen: step one renders');
  assert.ok(text.includes('Start using Cipher'), 'the guide runs to its last step');
  assert.ok(hosts.some((host) => host.tag === 'li'), 'the guide is one ordered list of steps');
});

test('the row no longer raises the after-signup tour sheet', () => {
  stubBrowserGlobals();
  app.useChatStore.setState({ showTutorial: false });
  const identity = { pk: 'test', npub: 'np1testaccount', lockApp() {}, panicWipe() {} };
  const tree = createTree(app.Wallet, { identity, onOpenChat: () => {} });

  const { hosts } = tree.render();
  const row = hosts.find((host) => host.tag === 'button' && textOf(host.props.children).includes('How to use'));
  row.props.onClick({});
  assert.equal(
    app.useChatStore.getState().showTutorial,
    false,
    'the row no longer raises the tutorial sheet the after-signup tour lives in',
  );
});

// The founder's copy, verbatim, pinned where the words live so a rewrite of
// the screen cannot drift them. Skips on a tree where the guide module has
// not landed yet — the behaviour test above is the red-first witness.
test("the guide is the founder's fifteen steps, verbatim", async (t) => {
  let data;
  try {
    data = await import(new URL('./lib/howToGuide.js', import.meta.url).href);
  } catch {
    t.skip('howToGuide.js lands with the screen change');
    return;
  }
  const steps = data.HOW_TO_STEPS;
  assert.equal(steps.length, 15, 'fifteen steps: the Calls step is gone by founder order');
  assert.deepEqual(
    steps.map((step) => [step.title, step.body]),
    [
      [
        'Welcome to Cipher',
        'Your messenger and your deals, in one place. No phone number, no email, no account to sign up for. Your messages are encrypted here on this device before they leave it. This guide walks through every part of the app.',
      ],
      [
        'Your account is on this device',
        'Cipher makes your account the first time you open it and keeps the key on this device only. You unlock with a passkey or a PIN. If this device is lost or wiped, the only way back is your recovery phrase — no one, including us, can restore it for you.',
      ],
      [
        'Save your recovery phrase',
        'Open Profile, then Backup. It holds your secret key and twelve words. Write the twelve words on paper and keep them somewhere only you can reach. Never type them into a chat, a photo or a website. Anyone who has them is you.',
      ],
      [
        'Chats',
        'Open Chats for private messages. Tap a row to show the preview of a chat you have not opened yet. Press and hold a row (or right-click on a computer) for its options: pin, mute, archive, block. Messages from people you have not answered wait under Profile, then Message requests.',
      ],
      [
        'Sending a message',
        'Type at the bottom and send. You can attach a photo or a file, record a voice note, and reply or react to a message by holding it. When a chat should not keep its messages, set a timer in the chat header: one day, three days, one week or one month. When the time runs out the message goes.',
      ],
      [
        'Groups',
        'Create a group from the menu at the top of Chats. A group has its own name and its own members, and its messages are encrypted with a key only the members hold. Add people by their address, and remove someone and they stop reading new messages.',
      ],
      [
        'The chat list menu',
        'The menu at the top of Chats holds the smaller tools. Burn note writes something that is said once and then gone. Saved holds the messages you kept. Scan opens the camera for an address. Notifications shows what happened while you were away. Refresh re-reads your chats from the relays.',
      ],
      [
        'Menus',
        "Open Menus to see vendors. Each menu is one vendor's own page: what they sell, the price in dollars, the weight in grams, and how they take payment. Filter the list to find what you want, then open a menu and message the vendor directly.",
      ],
      [
        'Buying',
        'You ask in the chat and the vendor accepts. The vendor then issues a payment address that belongs to your order alone — never send to an address from a different order, and never to an address you were given somewhere else. The app watches the chain and moves the order along as the coins arrive.',
      ],
      [
        'When payment counts',
        "Bitcoin counts once it is mined, and Monero after it is confirmed; the app shows each step on the order card. A default of three confirmations is used for Bitcoin and ten for Monero, and you can change those numbers under Profile, then Order settings. The vendor's own word is never a confirmation — only the chain is.",
      ],
      [
        'Orders',
        'Open Orders for everything you bought or sold. Each order shows what it was for, how it was paid, and where it stands. A receipt covers exactly one transaction, so if you paid twice you have two receipts. If something goes wrong, the order is where you raise it.',
      ],
      [
        'Selling',
        'Open Profile and choose Start selling. Add a Bitcoin address for receiving payments, or a Monero view key so each order gets its own address, then put your items up with a name, a weight in grams and a price in dollars. Every order you accept gets its own address, so no two buyers ever pay into the same one.',
      ],
      [
        'The You tab',
        'Profile holds the rest. Edit Profile changes your name, bio and photo. Accounts switches between accounts on this device. Order settings picks your preferred coin, how many confirmations count, and whether to vouch automatically. Privacy covers last seen and blocked people. Connections is where Tor and a proxy are set.',
      ],
      [
        'Locking and wiping',
        'Lock now closes the app and asks for your passkey or PIN again. Panic wipe erases this device: the account, the chats, the orders, everything, and it cannot be undone. Keep your twelve words somewhere else if you ever want to come back.',
      ],
      [
        'Start using Cipher',
        'You can reopen this guide any time under Profile → How to use. The app is yours; nothing here is shared with a server it does not need.',
      ],
    ],
  );
  // Founder order: nothing in the guide mentions a call. Word-bounded, so
  // "automatically" is not a hit.
  assert.equal(/\bcall/i.test(JSON.stringify(steps)), false, 'no step mentions calls');
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(steps)), false, 'no emoji in the guide');
});
