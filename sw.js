/*
 * Spendly service worker.
 *
 * Strategy:
 *  - precache the complete app shell on install (HTML, CSS, JS, manifest, icons);
 *  - serve navigations from that shell cache so the app opens instantly offline
 *    and the HTML always matches the cached JS/CSS generation;
 *  - cache-first for local static assets, with a network fallback for anything
 *    that is not in the precache yet;
 *  - only activate a new worker when the page asks, then remove old caches.
 *
 * The worker never opens IndexedDB. Updating the app cannot touch expenses.
 */

const CACHE_VERSION = 'v10';
const CACHE_PREFIX = 'spendly-';
const CACHE_NAME = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/core.js',
  './js/db.js',
  './js/repository.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

const SCOPE = self.registration.scope;
const INDEX_URL = new URL('./index.html', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: 'reload' bypasses the HTTP cache during an update so the new
    // generation is complete and internally consistent.
    await cache.addAll(APP_SHELL.map(path => new Request(
      new URL(path, SCOPE).href,
      { cache: 'reload' }
    )));
    // A first install activates automatically. An update waits for the page to
    // offer "Refresh", so a form in progress is never interrupted.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const shell = await cache.match(INDEX_URL);
  if (shell) return shell;

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200 && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

function offlineFallback() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#176b3a">
<title>Spendly is offline</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(60% 45% at 80% 0%, #e8f4ec, transparent 70%), #f3f6f2;
    color: #14251b; font: 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 360px; padding: 26px; border: 1px solid rgba(20,50,30,.1); border-radius: 22px;
    background: #fff; box-shadow: 0 20px 50px -30px rgba(15,35,22,.4); }
  .mark { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center;
    background: linear-gradient(150deg,#1f7a47,#0b3a24); color: #fff; font-weight: 700; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; letter-spacing: -.02em; }
  p { margin: 0 0 18px; font-size: 13px; line-height: 1.6; color: #5f7167; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 13px; background: #176b3a;
    color: #fff; font: 600 14px inherit; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">S</div>
  <h1>Spendly hasn’t been saved offline yet</h1>
  <p>Connect to the internet and open Spendly once. After that, the app and your saved expenses, salary and savings work offline.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
