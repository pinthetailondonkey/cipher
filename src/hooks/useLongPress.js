import { useCallback, useEffect, useRef } from 'react';

// A row answers a slow finger, not a tap: 500ms of stillness is a long press,
// and anything that stops being stillness — 8px of travel, a lift, a system
// cancel, an unmount — gives up on it. The handlers bolt onto a row's pointer
// events and leave taps, clicks and scroll to the row itself.
const LONG_PRESS_MS = 500;
// Squared travel: 8px in any direction, compared without a square root.
const MOVE_CANCEL_PX_SQ = 8 * 8;

export default function useLongPress(onLongPress) {
  const timerRef = useRef(null);
  const originRef = useRef({ x: 0, y: 0 });
  // The row re-renders with a fresh inline callback whenever a message
  // arrives; the press must fire the latest one, not the one captured at
  // pointerdown (same pattern as usePanicWipe's identityRef, synced in an
  // effect so no ref is written during render).
  const onLongPressRef = useRef(onLongPress);
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  }, [onLongPress]);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback((event) => {
    // Only the primary pointer starts a press: a second finger and a
    // right-click never did.
    if (event?.isPrimary === false) return;
    if (event?.button !== undefined && event.button !== 0) return;
    stop();
    originRef.current = { x: event?.clientX || 0, y: event?.clientY || 0 };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onLongPressRef.current?.(event);
    }, LONG_PRESS_MS);
  }, [stop]);

  const onPointerMove = useCallback((event) => {
    if (timerRef.current === null) return;
    if (event?.isPrimary === false) return;
    const dx = (event?.clientX || 0) - originRef.current.x;
    const dy = (event?.clientY || 0) - originRef.current.y;
    if (dx * dx + dy * dy >= MOVE_CANCEL_PX_SQ) stop();
  }, [stop]);

  // A lift or a system cancel is the finger changing its mind.
  const onPointerUp = useCallback(() => {
    stop();
  }, [stop]);

  const onPointerCancel = useCallback(() => {
    stop();
  }, [stop]);

  // An unmounted row must not fire: the timer dies with the component.
  useEffect(() => stop, [stop]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
