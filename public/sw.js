/*
 * The service worker.
 *
 * ===========================================================================
 * What this file is allowed to do, and what it must never do
 *
 * ARCHITECTURE §7, decided before any of it was built:
 *
 *   "The queue is TanStack Query's own paused-mutation mechanism persisted to
 *    IndexedDB — not a hand-rolled queue, and crucially NOT the service
 *    worker. The SW makes the app installable and serves the shell offline;
 *    it touches no writes at all."
 *
 * So this file serves GET requests for the app's own shell and static assets,
 * and nothing else. It does not queue, retry, replay or modify a write. It
 * does not go near Supabase.
 *
 * The reason is worth having in front of you while editing: a service worker
 * that retries writes is a second queue, running in a different process, with
 * its own idea of what has been sent. Two queues that can both send the same
 * invoice is how an invoice gets entered twice — and Background Sync makes
 * that specific mistake easy and appealing. The queue lives in the page, where
 * it can see the cache it is updating and tell somebody what it is doing.
 * ===========================================================================
 */

/**
 * Bump to evict every cached asset on the next load.
 *
 * Rarely needed: Next fingerprints its own build output, so a new deploy asks
 * for different filenames and the old ones simply age out below. This is for
 * the case where something cached under a STABLE url has to go — an icon, the
 * offline page, the manifest.
 */
const CACHE = 'shg-shell-v1';

/**
 * Cached at install so they are guaranteed present the first time the phone is
 * out of signal. Everything else is cached as it is used.
 *
 * Deliberately tiny. A precache list of a whole app is a list that goes stale
 * silently — install fails if a single entry 404s, and a service worker that
 * fails to install leaves the app with no offline behaviour at all and no
 * indication why.
 */
const SHELL = ['/offline', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, not addAll: addAll is atomic, so one missing file means
      // no offline support for anything. Each of these is independently useful.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  /*
   * The two guards that keep this worker honest. Both are absolute.
   *
   * 1. Only GET. A POST, PATCH or DELETE passes straight through to the
   *    network, untouched and unobserved. This is the line that stops this
   *    file from becoming a second write queue.
   *
   * 2. Only our own origin. Supabase requests — every read, every write, the
   *    auth token refresh — are none of this worker's business. Caching a
   *    signed-in read would serve one person's invoices to whoever opens the
   *    app next on that phone, and caching a token refresh is worse.
   */
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Next's build output is content-hashed: the filename changes when the file
  // does, so a cached copy can never be stale. Serve it from disk and skip the
  // network entirely.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationWithFallback(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Network first for pages, and the fallback is a page that says so.
 *
 * Network first rather than cache first because this app's screens are about
 * money and the difference between a figure from ten seconds ago and one from
 * Tuesday matters. When the network is there, the network wins.
 *
 * When it is not, the fallback is `/offline` — a page whose entire job is to
 * say the app is offline. Deliberately NOT the last dashboard we happen to
 * have cached: that would open showing figures with no date on them, which is
 * the trust-destroying failure the bug notes name. The queued writes are safe
 * on the phone either way, and this page says so.
 */
async function navigationWithFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match('/offline')) ?? Response.error();
  }
}

/*
 * ===========================================================================
 * Push
 *
 * ARCHITECTURE §8.1: push is a nudge on top of the in-app bell, never the
 * channel itself. The bell is the source of truth because push is not
 * deliverable — the phone can be off, the endpoint can expire, the OS can drop
 * it. Nothing below is allowed to be the only way somebody finds something out.
 *
 * Which is why this handler carries no data of its own. The payload is a
 * headline and a link; opening it goes to the app, where the real thing is.
 * ===========================================================================
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return; // Not ours, or malformed. Silence beats a notification saying "undefined".
  }

  const title = payload.title || 'SHG Invoices';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Same tag replaces rather than stacks: four invoices logged in a minute
      // should leave one notification on the lock screen, not four.
      tag: payload.tag || 'shg',
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  /*
   * Focus the app if it is already open rather than opening a second copy.
   * On a phone this is the difference between arriving back where you were and
   * arriving at a cold start of the same screen.
   */
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
