const CACHE_NAME = 'cipher-shell-__BUILD_ID__';

// A hashed asset that a deploy removed comes back from the host as the SPA
// fallback: 200 with index.html. Caching that under the asset's URL pins a
// page where a script or stylesheet should be, and an old tab then fails on
// the wrong MIME type every time it asks again. Only a response whose type
// fits what was asked for is kept.
function isCacheableAsset(request, url, response) {
  if (!response.ok) return false;
  if (url.pathname !== '/sw.js' && !url.pathname.startsWith('/assets/')) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) return false;
  if (request.destination === 'script') return /javascript|ecmascript/.test(type);
  if (request.destination === 'style') return type.includes('text/css');
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(['/', '/index.html']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('cipher-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const copy = response.clone();
            await caches.open(CACHE_NAME)
              .then((cache) => cache.put('/index.html', copy))
              .catch((error) => console.error('[offline] Could not cache the app shell:', error));
          }
          return response;
        })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (isCacheableAsset(request, url, response)) {
        const copy = response.clone();
        await caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, copy))
          .catch((error) => console.error('[offline] Could not cache app asset:', url.pathname, error));
      }
      return response;
    }),
  );
});

self.addEventListener('push', (event) => {
  let kind = 'message';
  try {
    const data = event.data?.json();
    if (data && data.kind === 'order') kind = 'order';
    if (data && data.kind === 'call') kind = 'call';
  } catch { /* a push with no JSON is still just "new message" */ }
  // The relay audience can spend the t tag that picks a title, so the
  // banner names only what a push can honestly claim. The kind rides in
  // data for the app's counters.
  event.waitUntil(self.registration.showNotification('New message', {
    body: 'Open Cipher to view it.',
    icon: '/icon-192.png',
    data: { kind },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => 'focus' in client);
    if (open) return open.focus();
    if (self.clients.openWindow) return self.clients.openWindow('/');
    return undefined;
  })());
});
