// AEGIS PET Service Worker — Phase 2
const CACHE_NAME = 'aegis-pet-v2';
const CACHE_URLS = ['/', '/index.html', '/manifest.json'];

// Install — cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first for API, cache-first for assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Skip non-GET and API calls
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses for app shell
        if (response.ok && CACHE_URLS.includes(url.pathname)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push — show notification
self.addEventListener('push', event => {
  let data = { title: '⚔️ Your pet needs you!', body: 'Daily trial ready. Keep your guardian strong!' };
  try {
    if (event.data) data = JSON.parse(event.data.text());
  } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'aegis-daily',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: '/' }
    })
  );
});

// Notification click — focus or open app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});
