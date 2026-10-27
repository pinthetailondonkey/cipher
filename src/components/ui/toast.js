// The toast queue module: state and its two imperative controls. The
// <Toast /> component is the only renderer; this file is only data, so
// handlers anywhere in the app can push without owning a tree.
const TOAST_MS = 4000;

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
  queue.push(entry);
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