/**
 * Service worker.
 *
 * Two jobs: make the app launch instantly from the home screen, and make it
 * open at all with no signal. A budget you can't check standing in a shop is
 * a budget you stop checking.
 *
 * Caching strategy is deliberately split by what the content is:
 *
 *   app shell  - cache first. HTML, CSS, JS and the engine modules change only
 *                when we deploy, and a new deploy bumps CACHE_VERSION.
 *   data       - network first, falling back to cache. Financial figures must
 *                never be served stale when the network could have given the
 *                real ones. Showing last night's balance as though it were
 *                current is exactly the failure this app exists to prevent.
 */

const CACHE_VERSION = 'v37';
const SHELL_CACHE = `budget-shell-${CACHE_VERSION}`;
const DATA_CACHE = `budget-data-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './redesign.css',
  './budget-clarity.js',
  './bills-center.js',
  './manifest.webmanifest',
  './vendor/open-props.min.css',
  './vendor/open-props-normalize.min.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  '../src/engine/normalize.js',
  '../src/engine/us-cities.js',
  '../src/engine/seed-rules.js',
  '../src/engine/categorize.js',
  '../src/engine/cadence.js',
  '../src/engine/recurring.js',
  '../src/engine/transfers.js',
  '../src/engine/income.js',
  '../src/engine/variable-income.js',
  '../src/engine/expenses.js',
  '../src/engine/allocate.js',
  '../src/engine/guidance.js',
  '../src/engine/child-transition.js',
  '../src/engine/subscriptions.js',
  '../src/engine/reliable-subscriptions.js',
  '../src/engine/forecast.js',
  '../src/engine/alerts.js',
  '../src/engine/bill-center.js',
  '../src/domain/payroll.js',
  '../src/payroll/pay-calculator.js',
  '../src/payroll/forecast.js',
  '../src/domain/bill.js',
  '../src/engine/budget/safe-to-spend.js',
  '../src/engine/budget/monthly-budget.js',
  '../src/engine/month-in-full.js',
  '../src/engine/split.js',
  '../src/engine/year-in-review.js',
  '../src/engine/bill-paycheck-plan.js',
  '../src/engine/bill-suggestions.js',
  '../src/engine/similar-payee.js',
  '../src/engine/merchant-domain.js',
  '../src/domain/provider-match.js',
  '../src/domain/bill-payment-match.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('budget-') && !key.endsWith(CACHE_VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isDocument = request.mode === 'navigate' || url.pathname.endsWith('/index.html');
  if (isDocument) {
    event.respondWith(shellDocument(request));
    return;
  }

  const isData = url.pathname.includes('/fixtures/') || url.pathname.endsWith('.json');

  if (isData) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function shellDocument(request) {
  const response = await cacheFirst(request);
  if (!response?.ok) return response;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return response;

  let refreshed = await response.text();

  if (!refreshed.includes('redesign.css')) {
    refreshed = refreshed.replace(
      '</head>',
      '  <link rel="stylesheet" href="./redesign.css" />\n</head>',
    );
  }

  if (!refreshed.includes('budget-clarity.js')) {
    refreshed = refreshed.replace(
      '</body>',
      '  <script src="./budget-clarity.js"></script>\n</body>',
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');

  return new Response(refreshed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
    throw new Error('offline and no cached shell');
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', 'true');
      return new Response(await cached.blob(), { status: 200, headers });
    }
    throw new Error('offline and no cached data');
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Family Budget', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Family Budget', {
      body: payload.body ?? '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: payload.tag ?? 'budget-alert',
      renotify: true,
      data: { url: payload.url ?? './index.html' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
