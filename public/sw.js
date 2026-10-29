const CACHE_NAME = 'cipher-shell-v3';
const MANIFEST_URL = '/asset-manifest.json';

// The build writes asset-manifest.json naming every file it put under /assets/.
// Without it the app could only cache a screen after someone had opened that
// screen, so a person with no signal could not start the app: the code for the
// first screen after unlock is a chunk nobody has fetched yet.
//
// Every file is fetched on its own line and its own failure. One file that is
// missing, and a manifest that will not fetch or will not parse, are logged and
// skipped — none of them stops the app installing. Only same-origin names from
// the manifest's own list are ever requested.
async function precacheBuildAssets(cache) {
  let files = [];
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (response.ok) {
      const manifest = await response.json();
      if (Array.isArray(manifest?.files)) files = manifest.files;
    }
  } catch (error) {
    console.error('[offline] Could not read the asset manifest:', error);
  }
  await Promise.all(files
    .filter((file) => typeof file === 'string' && file.startsWith('/assets/'))
    .map((file) => cache.add(file).catch((error) => console.error('[offline] Could not pre-cache:', file, error))));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(['/', '/index.html']);
    await precacheBuildAssets(cache);
    await self.skipWaiting();
  })());
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
    // Only the app's own address is the app shell. Pages that sit beside it
    // (/download, /privacy) are their own documents: cached as the shell they
    // would be what opens offline instead of the messenger, and offline they
    // simply fail rather than pretend to be the app.
    if (url.pathname !== '/') {
      event.respondWith(fetch(request));
      return;
    }
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
