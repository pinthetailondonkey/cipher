// A locked phone buzzes only after a gateway you run is pasted in Connections.
// The notice is "New message" or "New order". The gateway is not given the text.

export function notificationFromPush(raw) {
  const kind = raw && typeof raw === 'object' && raw.kind === 'order' ? 'order' : 'message';
  return {
    title: kind === 'order' ? 'New order' : 'New message',
    body: 'Open Cipher to view it.',
    data: { kind },
  };
}

export function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerWithGateway({ gatewayUrl, pubkey, fetchImpl = globalThis.fetch, subscribe } = {}) {
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
