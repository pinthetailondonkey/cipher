// A locked phone buzzes only after a gateway you run is pasted in Connections.
// The notice says "New message": the app, not the banner, names what arrived.
// Messages are tagged t=msg. Orders are tagged t=order. Calls are tagged t=call. Typing, receipts, and key bundles are not.

export const BUZZ_TAG = 'msg';
export const ORDER_TAG = 'order';
export const CALL_TAG = 'call';
const SILENT_TYPES = new Set(['typing', 'read', 'pin', 'gkey']);

export function buzzTagFor(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.t === 'gkey' || payload.type === 'gkey') return null;
  if (payload.type === 'call' || payload.t === 'call') return CALL_TAG;
  if (payload.type === 'order_request' || payload.type === 'order_update' || payload.t === 'order') return ORDER_TAG;
  if (SILENT_TYPES.has(payload.type) || SILENT_TYPES.has(payload.t)) return null;
  return BUZZ_TAG;
}

export function payloadShouldBuzz(payload) {
  return buzzTagFor(payload) != null;
}

export function withBuzzTag(tags, payload) {
  const next = Array.isArray(tags) ? tags.map((tag) => tag.slice()) : [];
  const tag = buzzTagFor(payload);
  if (!tag) return next;
  if (next.some((row) => row[0] === 't' && row[1] === tag)) return next;
  next.push(['t', tag]);
  return next;
}

export function eventShouldBuzz(event) {
  return Array.isArray(event?.tags) && event.tags.some((tag) => tag[0] === 't' && tag[1] === BUZZ_TAG);
}

export function eventShouldRing(event) {
  return Array.isArray(event?.tags) && event.tags.some((tag) => tag[0] === 't' && tag[1] === CALL_TAG);
}

export function eventShouldOrder(event) {
  return Array.isArray(event?.tags) && event.tags.some((tag) => tag[0] === 't' && tag[1] === ORDER_TAG);
}

export function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function nativeTransport(platform) {
  if (platform === 'android') return 'fcm';
  if (platform === 'ios') return 'apns';
  return null;
}

export function isNativeShell() {
  const cap = globalThis.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

export async function subscribeNative() {
  if (!isNativeShell()) return null;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const platform = globalThis.Capacitor.getPlatform();
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') throw new Error('Notifications are blocked, so a locked phone will not buzz.');
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native push did not return a token.')), 15000);
    PushNotifications.addListener('registration', (row) => {
      clearTimeout(timer);
      resolve(row.value);
    });
    PushNotifications.addListener('registrationError', (error) => {
      clearTimeout(timer);
      reject(new Error(error?.error || 'Native push registration failed.'));
    });
    PushNotifications.register();
  });
  return { platform, token };
}

export async function registerWithGateway({ gatewayUrl, pubkey, fetchImpl = globalThis.fetch, subscribe, native } = {}) {
  const base = String(gatewayUrl || '').trim();
  if (!base) return { buzzing: false, reason: 'No push gateway is set. A locked phone will not buzz.' };
  let origin;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad');
    origin = url.origin;
  } catch {
    throw new Error('The push gateway address is not a URL.');
  }
  if (typeof native === 'function') {
    const got = await native();
    if (!got?.token) {
      return { buzzing: false, reason: 'This installed app did not return a push token. Web Push does not run in the app shell.' };
    }
    const transport = nativeTransport(got.platform);
    if (!transport) throw new Error('Native push is only for the installed Android or iOS app.');
    const posted = await fetchImpl(new URL('/native', origin).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey, transport, token: got.token }),
    });
    const body = await posted.json().catch(() => ({}));
    if (!posted?.ok) throw new Error(body?.error || 'The push gateway refused this phone.');
    // The gateway decides: true only when it stored the token and holds the key file.
    const buzzing = body?.buzzing === true;
    return {
      buzzing,
      transport,
      reason: body.reason || (buzzing ? '' : 'The token is stored. This gateway has no FCM or APNs key, so the installed app does not buzz yet.'),
    };
  }
  const descriptor = await fetchImpl(new URL('/cipher-push.json', origin).href, { headers: { Accept: 'application/json' } });
  if (!descriptor?.ok) throw new Error('The push gateway did not offer a key.');
  const body = await descriptor.json();
  const vapidPublicKey = String(body?.vapidPublicKey || '').trim();
  if (!vapidPublicKey) throw new Error('The push gateway did not offer a key.');
  if (typeof subscribe !== 'function') {
    return { buzzing: false, reason: 'This browser cannot buzz while the phone is locked. It can only notify while Cipher is open.' };
  }
  const subscription = await subscribe(vapidPublicKey);
  if (!subscription) {
    return { buzzing: false, reason: 'This browser cannot buzz while the phone is locked. It can only notify while Cipher is open.' };
  }
  const posted = await fetchImpl(new URL('/subscribe', origin).href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, subscription, transport: 'webpush' }),
  });
  if (!posted?.ok) throw new Error('The push gateway refused this phone.');
  return { buzzing: true };
}

export async function subscribeBrowser(vapidPublicKey) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof Notification === 'undefined' || !('PushManager' in globalThis)) {
    return null;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked, so a locked phone will not buzz.');
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing.toJSON();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  return subscription.toJSON();
}
