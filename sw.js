// ---------------------------------------------------------------------
// CACHE_NAME — cache-busting version for this service worker's asset
// cache. Bump it on every deploy that changes any cached file, so old
// clients pick up the new files instead of serving stale ones from cache.
//
// This is INDEPENDENT of APP_VERSION / APP_VERSION_DATE in app.js (the
// small version badge shown in the corner of the app, even on the lock
// screen). The two live in different files and do NOT sync automatically
// — bump both together by hand on every deploy. See the matching comment
// above APP_VERSION near the top of app.js.
// ---------------------------------------------------------------------
const CACHE_NAME = 'fleetlog-pwa-v1.9.5';

// As of v1.9.3 every asset (Tailwind, pdf.js + worker, Inter webfont) is
// vendored locally under ./vendor and ./fonts instead of being fetched
// from cdn.jsdelivr.net / cdnjs.cloudflare.com / fonts.googleapis.com /
// fonts.gstatic.com at runtime — so there's no separate CDN_ASSETS list
// to keep in sync anymore. It's all same-origin and lives in STATIC_ASSETS.
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './pdf-worker-init.js',
  './styles.css',
  './manifest.json',
  './icons/favicon.ico',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png',
  './vendor/tailwind/tailwind.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './fonts/inter.css',
  './fonts/files/inter-latin-300-normal.woff2',
  './fonts/files/inter-latin-400-normal.woff2',
  './fonts/files/inter-latin-500-normal.woff2',
  './fonts/files/inter-latin-600-normal.woff2',
  './fonts/files/inter-latin-700-normal.woff2',
  './fonts/files/inter-latin-800-normal.woff2'
];

// Allow the page to force an already-installed, waiting service worker to
// activate immediately (used by the update-detection code in index.html).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Install Event - Pre-cache Static Assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching static assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Stale-While-Revalidate Strategy
self.addEventListener('fetch', (event) => {
  // Ignore non-GET requests or browser extension schemes
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => {
          // Silent catch for offline status
        });

        return cachedResponse || fetchPromise;
      });
    })
  );
});