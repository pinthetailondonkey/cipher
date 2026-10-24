import { Capacitor } from '@capacitor/core';

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

export const showNotification = async (type = 'message') => {
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