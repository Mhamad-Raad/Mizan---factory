/**
 * The installable shortcut of FR-1313 (Proposed — not requested), and nothing more.
 *
 * It caches the **application shell** — the built JavaScript, CSS and fonts — so the app opens
 * instantly from the home screen on a tablet with a slow connection. It deliberately does not
 * cache a single byte of data: A-12 says there is no offline editing in v1, and a stale order
 * or a stale balance shown as if it were current is worse than a screen that says it cannot
 * reach the server. Every `/api/` request goes to the network, always.
 *
 * Removable without touching anything else: delete this file, the manifest and the two lines in
 * `index.html` that register it (FR-1313's own acceptance criterion).
 */
const SHELL = 'mizan-shell-v1';

self.addEventListener('install', (event) => {
  // The shell is filled as the browser fetches it, not from a hard-coded list: the built file
  // names carry content hashes, and a list would be wrong at the next deploy.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // A new version of the app means a new shell; the old one is not worth keeping.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== SHELL).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never the API, never anything but a plain GET, never another origin.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // The document itself: network first, so a deploy is picked up, with the cached shell as the
  // fallback when there is no connection — which is what makes the icon on the home screen
  // open something rather than nothing.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL);
          cache.put('/', response.clone());
          return response;
        } catch {
          const cached = await caches.match('/');
          if (cached) return cached;
          throw new Error('offline and no cached shell');
        }
      })(),
    );
    return;
  }

  // Static assets are content-hashed, so a cache hit is always the right file.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(SHELL);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
