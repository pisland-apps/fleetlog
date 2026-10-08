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
const CACHE_NAME = 'fleetlog-pwa-v1.9.19';

// As of v1.9.3 every asset (Tailwind, pdf.js + worker, Inter webfont) is
// vendored locally under ./vendor and ./fonts instead of being fetched
// from cdn.jsdelivr.net / cdnjs.cloudflare.com / fonts.googleapis.com /
// fonts.gstatic.com at runtime — so there's no separate CDN_ASSETS list
// to keep in sync anymore. It's all same-origin and lives in STATIC_ASSETS.
//
// As of v1.9.9, './index.html' is deliberately NOT in this list — see the
// note above the fetch handler's navigate-mode branch below for why.
const STATIC_ASSETS = [
  './',
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
  // v1.9.18: pdf.js lives in a version-named folder (PDFJS_DIR in
  // pdf-worker-init.js) so its main file, worker and decoders can only come
  // from the same release. Keep these lines and PDFJS_DIR in step.
  './vendor/pdfjs-6.4.299/pdf.min.mjs',
  './vendor/pdfjs-6.4.299/pdf.worker.min.mjs',
  // Image decoders for scanner PDFs: the .wasm files are the normal path; the
  // *_nowasm_fallback.js are what pdf.js loads instead if a CSP forbids
  // compiling WebAssembly. Both must work offline.
  './vendor/pdfjs-6.4.299/wasm/jbig2.wasm',
  './vendor/pdfjs-6.4.299/wasm/openjpeg.wasm',
  './vendor/pdfjs-6.4.299/wasm/qcms_bg.wasm',
  './vendor/pdfjs-6.4.299/wasm/jbig2_nowasm_fallback.js',
  './vendor/pdfjs-6.4.299/wasm/openjpeg_nowasm_fallback.js',
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
      // v1.9.18: cache:'reload' so the pre-cache never copies a stale file out
      // of the browser's own HTTP cache (GitHub Pages sends max-age=600),
      // which could otherwise precache a half-old, half-new set of files.
      return cache.addAll(STATIC_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
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

  // Navigations (address-bar loads, links, bookmarks, an installed shortcut
  // relaunching) always resolve through the canonical './' cache entry,
  // regardless of the exact path requested (e.g. '/index.html'). This is
  // required on hosts like Cloudflare Pages, which 301/308-redirect
  // '/index.html' -> '/' by default: if './index.html' were precached (or
  // ever fetched) directly, that fetch would silently follow the redirect
  // and the resulting Response — with `redirected: true` baked in — would
  // get cached under the './index.html' key. Chrome refuses to let a
  // service worker answer a *navigation* request with a redirected
  // Response, and fails the whole load with net::ERR_FAILED. Routing every
  // navigation through './' instead sidesteps this entirely, and also
  // means an old '/index.html' bookmark or shared link still resolves to
  // a working page instead of a dead cache slot.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match('./').then((cachedResponse) => {
          const fetchPromise = fetch('./').then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              cache.put('./', networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => {
            // Silent catch for offline status
          });

          return cachedResponse || fetchPromise;
        });
      })
    );
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