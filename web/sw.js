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

const CACHE_VERSION = 'v18';
const SHELL_CACHE = `budget-shell-${CACHE_VERSION}`;
const DATA_CACHE = `budget-data-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './vendor/open-props.min.css',
  './vendor/open-props-normalize.min.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  // Engine modules the app imports directly.
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
  '../src/engine/forecast.js',
  '../src/engine/alerts.js',
  // Payroll: shift logging computes its forecast client-side, so these must be
  // cached alongside the engines or the Shifts view breaks offline.
  '../src/domain/payroll.js',
  '../src/payroll/pay-calculator.js',
  '../src/payroll/forecast.js',
  // Bills: app.js imports daysUntilDue statically (not lazily, unlike
  // connect.js/shifts.js/bills.js themselves), so it's required to parse at
  // all, the same reason the payroll modules above are here.
  '../src/domain/bill.js',
  // Safe-to-spend: app.js imports calculateSafeToSpend statically, so without
  // this the module 404s offline and app.js fails to parse — taking the whole
  // app down, not just the safe-to-spend headline.
  '../src/engine/budget/safe-to-spend.js',
  '../src/engine/budget/monthly-budget.js',
  // Bills-by-paycheck: same reason as the modules above — imported statically.
  '../src/engine/bill-paycheck-plan.js',
  // Bill suggestions from recurring charges: imported statically by app.js and
  // reaches into domain/provider-match.js, so both have to be here or the
  // Bills tab 404s offline.
  '../src/engine/bill-suggestions.js',
  '../src/domain/provider-match.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Individually, so one missing asset doesn't fail the whole install and
      // leave the app with no service worker at all.
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
  // Never cache anything crossing to another origin — the Supabase API in
  // particular. Cached financial data outside our control is not a tradeoff
  // worth making for a slightly faster load.
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.includes('/fixtures/') || url.pathname.endsWith('.json');

  if (isData) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

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
    // Offline and never cached. Fall back to the shell so a deep link still
    // opens the app rather than a browser error page.
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
      // Tag it so the UI can say the figures are from the last successful
      // load rather than presenting them as current.
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', 'true');
      return new Response(await cached.blob(), { status: 200, headers });
    }
    throw new Error('offline and no cached data');
  }
}

/**
 * Push notifications.
 *
 * iOS delivers these only to a PWA installed via Safari's Add to Home Screen —
 * not to a Safari tab — and only on iOS 16.4 or later. Android has no such
 * restriction. Wired up here so the alerts engine has somewhere to send urgent
 * items once a push service is configured.
 */
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
      // Alerts about money should not silently replace each other.
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
      // Focus an open window rather than stacking another copy.
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
