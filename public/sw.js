const CACHE_NAME = 'cipher-shell-v1';

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
      if (response.ok && (url.pathname.startsWith('/assets/') || url.pathname === '/sw.js')) {
        const copy = response.clone();
        await caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, copy))
          .catch((error) => console.error('[offline] Could not cache app asset:', url.pathname, error));
      }
      return response;
    }),
  );
});