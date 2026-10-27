import { Capacitor } from '@capacitor/core';
import { NOTIFICATION_PER_PEER_MS, NOTIFICATION_QUIET_MS, notificationAllowed } from './notificationThrottle';
import { haptic } from './haptics';

// The gate every OS notification passes before it can fire. It remembers the
// time of the last notification overall and the last one per counterparty,
// and refuses whenever the pure timing rule from notificationThrottle says
// a burst is under way. (security S11)
const lastPerPeer = new Map();
let lastAny = 0;

export function gateNotification(peer = '', now = Date.now()) {
  const allowed = notificationAllowed({
    peer,
    now,
    lastPerPeer: Object.fromEntries(lastPerPeer),
    lastAny,
    perPeerMs: NOTIFICATION_PER_PEER_MS,
    quietMs: NOTIFICATION_QUIET_MS,
  });
  if (allowed) {
    lastPerPeer.set(peer, now);
    lastAny = now;
  }
  return allowed;
}

// For tests only: clears the remembered times.
export function resetNotificationGate() {
  lastPerPeer.clear();
  lastAny = 0;
}

export const requestNotificationPermission = async () => {
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const permission = await LocalNotifications.requestPermissions();
      return permission.display === 'granted';
    }
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      return permission === 'granted';
    }
    return false;
  } catch (error) {
    console.error('[notifications] Permission request failed:', error);
    return false;
  }
};

export const showNotification = async (type = 'message', peer = '') => {
  // The message has already landed, saved, and marked unread by the time
  // this is called; the throttle holds back only this OS notification.
  if (!gateNotification(peer)) return;
  // Receive-side buzz (backlog 6): the same gate that throttles the OS
  // notification throttles the vibration — one buzz per accepted
  // notification, never a burst. Call rings buzz in CallOverlay instead;
  // typing, read, pin and key bundles never reach this door.
  haptic(type === 'order' ? 'heavy' : 'light');
  const isOrder = type === 'order';
  const title = isOrder ? 'New Order' : 'New Message';
  const body = 'Open Cipher to view it.';

  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const notificationId = Math.floor(Math.random() * 2147483646) + 1;
      await LocalNotifications.schedule({
        notifications: [{
          title,
          body,
          id: notificationId,
          schedule: { at: new Date(Date.now() + 1000) },
          sound: null,
          attachments: null,
          actionTypeId: '',
          extra: { route: 'chat' },
        }],
      });
    } else if (
      typeof document !== 'undefined' &&
      document.visibilityState !== 'visible' &&
      'Notification' in window &&
      Notification.permission === 'granted'
    ) {
      new Notification(title, { body, icon: '/icon-192.png' });
    }
  } catch (error) {
    console.error('[notifications] Could not schedule notification:', error);
  }
};