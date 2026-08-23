/**
 * WolffMsg service worker.
 *
 * Two jobs: keep an offline shell so the app opens without a network, and
 * receive push notifications.
 *
 * What it deliberately does NOT do is cache API responses. Those are
 * ciphertext and session-scoped; caching them would leave message data in a
 * store that survives sign-out, which is exactly what sign-out is supposed to
 * clear.
 */

const VERSION = 'wolffmsg-v1';
const SHELL_CACHE = `${VERSION}-shell`;

/**
 * Where the app is published.
 *
 * `/` for the usual deployment, `/<repo>/` when the client is served from a
 * static host under a subpath. Derived from this file's own URL rather than
 * hard-coded, so one build works in both places.
 */
const BASE = new URL('./', self.location.href).pathname;
const at = (path) => `${BASE}${path}`;

/** The minimum needed to render the app frame before any network call. */
const SHELL_ASSETS = [
  BASE,
  at('index.html'),
  at('manifest.webmanifest'),
  at('icons/icon.svg'),
  at('icons/icon-192.png'),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `reload` bypasses the HTTP cache so an update is not seeded with a
      // stale copy of index.html.
      .then((cache) =>
        cache.addAll(SHELL_ASSETS.map((url) => new Request(url, { cache: 'reload' }))),
      )
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never touch the API or the socket: those carry live, session-scoped data.
  if (url.pathname.startsWith(at('api/')) || url.pathname.startsWith(at('ws'))) return;

  // Navigations: network first so a deploy is picked up, falling back to the
  // cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches
            .open(SHELL_CACHE)
            .then((cache) => cache.put(at('index.html'), copy));
          return response;
        })
        .catch(() =>
          caches
            .match(at('index.html'))
            .then(
              (cached) =>
                cached ??
                new Response('<h1>Offline</h1>', {
                  headers: { 'content-type': 'text/html' },
                }),
            ),
        ),
    );
    return;
  }

  // Build assets are content-hashed, so cache-first is safe and fast.
  if (url.pathname.startsWith(at('assets/')) || url.pathname.startsWith(at('icons/'))) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

/**
 * Push.
 *
 * The payload carries no message content — the server cannot read messages, so
 * it has none to send. If a window is already open and focused, no notification
 * is raised at all: the app itself will have shown the message.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'WolffMsg', body: 'New message', chatId: null };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* keep the default */
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const focused = clients.some((client) => client.focused);
      if (focused) return undefined;

      return self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: at('icons/icon-192.png'),
        badge: at('icons/icon-192.png'),
        tag: payload.chatId ? `chat-${payload.chatId}` : 'wolffmsg',
        renotify: false,
        data: { chatId: payload.chatId },
        silent: false,
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  const target = chatId ? `${BASE}?chat=${encodeURIComponent(chatId)}` : BASE;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Reuse an open tab rather than piling up new ones.
        const existing = clients.find((client) =>
          client.url.startsWith(`${self.location.origin}${BASE}`),
        );
        if (existing) {
          void existing.focus();
          return existing.navigate?.(target);
        }
        return self.clients.openWindow(target);
      }),
  );
});
