'use strict';
/* CreativeStudio AI Pro — service worker (v2.5.0 PWA).
   Offline app-shell cache: the SPA shell (HTML + CSS + JS) is cached on
   install so the app opens offline. API calls (/api/*) are NEVER cached
   and always go to the network — a stale cached API response would lie
   about projects, media and renders. Static assets are cache-first with
   a network fallback; navigations fall back to the cached shell. */
const CACHE_NAME = 'creative-studio-v250-1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/tokens.css',
  '/styles.css',
  '/home.css',
  '/editor.css',
  '/video-editor.css',
  '/bulk.css',
  '/music.css',
  '/voice.css',
  '/shorts.css',
  '/ai-studio.css',
  '/social.css',
  '/marketplace.css',
  '/docs-slides.css',
  '/admin.css',
  '/app.js',
  '/editor.js',
  '/video-editor.js',
  '/bulk.js',
  '/music.js',
  '/voice.js',
  '/shorts.js',
  '/ai-studio.js',
  '/magic-tools.js',
  '/stock.js',
  '/assistant.js',
  '/collab.js',
  '/social.js',
  '/marketplace.js',
  '/docs-slides.js',
  '/admin.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* offline at first install — the shell caches on next load */ })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API + uploads + renders + published sites: network only, never cached.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sites/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
