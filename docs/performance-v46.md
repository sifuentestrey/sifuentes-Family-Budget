# Startup performance repair (v46)

This release makes the returning-user boot path non-blocking on mobile.

- The bottom navigation remains mounted while session and transaction data hydrate.
- Bills and budget targets load after the first real-data paint instead of blocking it.
- Connect-only metadata (provider connections, members, invites) hydrates in parallel.
- The service worker pre-caches only the critical shell instead of the full engine graph.
- `reset.html` clears old `budget-*` caches and service-worker registrations, then reopens the current build.
- The main HTML includes sentinels that prevent retired v44 overlay scripts from being injected by an older controller during cache recovery.
