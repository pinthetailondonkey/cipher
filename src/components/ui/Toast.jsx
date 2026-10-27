import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { pushToast, dropToast, subscribe, queued } from './toast';
import { useChatStore } from '../../store/chatStore';

// THE toast banner renderer, mounted once for the whole app. setToast cones
// feed it through the store subscription; anything outside the store calls
// pushToast() from ui/toast.js. A banner is a status, lived 4 seconds max,
// dismissed by a tap — never a stuck sign.
const DOT = {
  error: 'bg-danger',
  success: 'bg-success',
  info: 'bg-accentText',
};

export default function Toast({ className = '' }) {
  const [, force] = useState(0);
  const lastFromStore = useRef(null);

  useEffect(() => {
    const render = () => force((n) => n + 1);
    const unsubscribeQueue = subscribe(render);
    // The store toast (setToast) feeds the same queue, so every existing
    // consumer keeps working with its store API untouched. Unrelated store
    // writes re-fire this callback while a banner is live, so only a new
    // toast object is admitted.
    const initial = useChatStore.getState()?.toast;
    if (initial) pushToast(initial);
    lastFromStore.current = initial ?? null;
    const unsubscribeStore = useChatStore.subscribe((state) => {
      if (state?.toast && state.toast !== lastFromStore.current) {
        lastFromStore.current = state.toast;
        pushToast(state.toast);
      }
      if (!state?.toast) lastFromStore.current = null;
    });
    return () => {
      unsubscribeQueue();
      unsubscribeStore();
    };
  }, []);

  const entries = queued();

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-x-0 top-safe z-toast mx-auto flex w-[min(94%,26rem)] flex-col gap-2 ${className}`}
    >
      <AnimatePresence>
        {entries.map((entry) => (
          <motion.button
            key={entry.id}
            type="button"
            initial={{ y: -16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            onClick={() => dropToast(entry.id)}
            className="rounded-2xl border border-line bg-panelStrong px-4 py-3 shadow-2xl"
          >
            <span className="flex items-center gap-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[entry.type]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{entry.message}</span>
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
