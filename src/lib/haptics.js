export const haptic = (style = 'light') => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    switch(style) {
      case 'light': navigator.vibrate(10); break;
      case 'medium': navigator.vibrate(25); break;
      case 'heavy': navigator.vibrate([50, 30, 50]); break; // Success/Payment
      case 'error': navigator.vibrate([50, 50, 50, 50]); break;
      case 'ring': navigator.vibrate([300, 150, 300]); break; // Incoming call; re-fires with the ringtone while it keeps ringing
    }
  }
};

// Receive-side patterns, keyed off the buzz tags the sender stamped
// (t=msg, t=order, t=call). Typing, read, pin and key bundles never buzz —
// that rule already lives in buzzTagFor; this only consumes its verdict.
// The ring is a long double-pulse, refired with the ringtone for as long
// as the call keeps ringing, so it reads apart from a message arrival.
export const buzzHaptic = (tag) => {
  if (tag === 'order') haptic('heavy');
  else if (tag === 'call') haptic('ring');
  else if (tag === 'msg') haptic('heavy');
};

// Pattern names for tests and callers that want the intent, not the buzz.
export const BUZZ_HAPTIC = { msg: 'heavy', order: 'heavy', call: 'ring' };