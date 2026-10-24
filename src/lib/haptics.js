export const haptic = (style = 'light') => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    switch(style) {
      case 'light': navigator.vibrate(10); break;
      case 'medium': navigator.vibrate(25); break;
      case 'heavy': navigator.vibrate([50, 30, 50]); break; // Success/Payment
      case 'error': navigator.vibrate([50, 50, 50, 50]); break;
    }
  }
};