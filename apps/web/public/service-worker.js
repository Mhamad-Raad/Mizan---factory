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
          // Only a good answer becomes the offline shell: caching a 502 from a restarting
          // container would hand that page to everybody who opens the icon on a tablet with no
          // signal, and it would stay there until the next time they had signal.
          if (response.ok) {
            const cache = await caches.open(SHELL);
            await cache.put('/', response.clone());
          }
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
        await cache.put(request, response.clone());
        await trim(cache);
      }
      return response;
    })(),
  );
});

/**
 * The shell, bounded.
 *
 * Built file names carry a content hash, so every deployment writes new entries and the old
 * ones are never asked for again — and this file does not change between deployments, so
 * `activate` (which is where a cache is usually cleaned) may not run for years. On a system
 * that is meant to be installed once and used for a decade, an unbounded cache on a cheap
 * tablet is a slow leak, so the cache keeps the most recent entries and drops the rest. The
 * Cache API returns keys in insertion order, which is the only ordering needed here.
 */
async function trim(cache, keep = 120) {
  const keys = await cache.keys();
  if (keys.length <= keep) return;
  // Everything but the shell document: that one entry is what makes the icon on the home
  // screen open something when there is no connection, and it is never worth evicting.
  const evictable = keys.filter((key) => new URL(key.url).pathname !== '/');
  await Promise.all(evictable.slice(0, keys.length - keep).map((key) => cache.delete(key)));
}
