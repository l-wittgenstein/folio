// Folio service worker: offline app shell + receiving PDFs shared from other apps.
const VERSION = 'folio-v2';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './reflow.js',
  './store.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon.png',
  './literata-latin.woff2',
  './literata-latin-ext.woff2',
  './pdf.min.mjs',
  './pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Shared PDFs land in a small inbox database; the page imports them on load.
function openInbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('folio-inbox', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('inbox', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('file').filter((f) => f && typeof f !== 'string');
    if (files.length) {
      const db = await openInbox();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('inbox', 'readwrite');
        for (const f of files) tx.objectStore('inbox').add({ name: f.name || 'Shared document.pdf', blob: f });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
  } catch (err) {
    // Fall through to the app; it will show the library.
  }
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Character maps and standard fonts for unusual PDFs come from the CDN once, then stay cached.
  if (url.hostname === 'cdn.jsdelivr.net' && e.request.method === 'GET') {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;

  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

  // Navigations: serve the cached shell so the app opens offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else: cache first, then network (and keep a copy, e.g. cmaps and fonts used by a PDF).
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
