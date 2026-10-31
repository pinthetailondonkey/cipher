// The toast queue module: state and its two imperative controls. The
// <Toast /> component is the only renderer; this file is only data, so
// handlers anywhere in the app can push without owning a tree.
const TOAST_MS = 4000;
const MAX_LIVE = 3;

let seq = 0;
const queue = [];
const subscribers = new Set();

function emit() {
  const snapshot = [...queue];
  subscribers.forEach((render) => render(snapshot));
}

export const subscribe = (render) => {
  subscribers.add(render);
  return () => subscribers.delete(render);
};

export function pushToast(toast) {
  const entry = {
    id: ++seq,
    type: toast?.type === 'error' || toast?.type === 'success' ? toast.type : 'info',
    message: typeof toast === 'string' ? toast : (toast?.message ?? ''),
    bornAt: Date.now(),
  };
  // A repeat of a message still on screen replaces that banner instead of
  // stacking beside it — hammering copy once built a tower of "Copied!".
  // The displaced entry's own dropToast timer later finds it gone and
  // returns, so no stray drop leaks through.
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].message === entry.message) queue.splice(i, 1);
  }
  queue.push(entry);
  // Belt and braces: a burst of all-distinct messages still cannot tower
  // past the cap; the oldest fall off first.
  while (queue.length > MAX_LIVE) queue.shift();
  emit();
  globalThis.setTimeout(() => dropToast(entry.id), TOAST_MS);
  return entry.id;
}

export function dropToast(id) {
  const index = queue.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  queue.splice(index, 1);
  emit();
}

// Test-only view of the live queue; the component reads the same array.
export const queued = () => [...queue];