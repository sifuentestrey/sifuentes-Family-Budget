# On-demand notes and payroll sync

The notes getter and payroll getter are separate read-only providers that can
share the same provider/sync architecture. They must **not** share credentials.
Replacing a payroll session must not disconnect or overwrite the notes getter.

## Intended workflow

1. The user explicitly requests a refresh and supplies a fresh browser cookie
   export through the trusted runtime.
2. The runtime creates a `createRuntimeCookieSessionStore` instance with the
   exact approved HR hosts. The export is held only in that process closure.
3. The UKG/MyTHR adapter requests only configured read endpoints. The session
   store returns only cookies that match each request URL's HTTPS host and path.
4. Tenant-specific parsers convert the returned timecard/paystub data into the
   existing payroll domain objects.
5. The sync engine stores normalized time entries, paystubs, deductions,
   earnings, and non-secret statement metadata. It never stores cookies.
6. The runtime clears the session when the refresh completes or after its short
   TTL. A later refresh requires a new export.

The existing notes getter continues to use its own provider and credential
store. It can be run before or after payroll sync without any payroll-specific
behavior or session data leaking into it.

## Security boundaries

- Never commit cookie exports, screenshots, downloaded paystubs, session IDs,
  employee IDs, SAML payloads, or raw request/response headers.
- Never place these cookies in browser `localStorage`, Supabase tables, logs,
  analytics, error messages, fixtures, or test snapshots.
- Use `allowedHosts` for every runtime store. MyTHR cookies must not be sent to
  UKG, and UKG cookies must not be sent to MyTHR.
- Keep payroll transport read-only. The provider issues GET requests only; it
  cannot approve a timecard, submit a correction, or change withholding.
- Persist only normalized payroll facts needed for forecasting and
  reconciliation. Paystub metadata is explicitly non-secret.

## Runtime example

```js
const payrollSession = createRuntimeCookieSessionStore({
  allowedHosts: ['mythr.org', 'prd.mykronos.com'],
  ttlMs: 30 * 60 * 1000,
});

payrollSession.set(cookieExportFromTrustedRuntime);

const payroll = createUkgPayrollProvider({
  baseUrl: 'https://texashealth-ss3.prd.mykronos.com',
  endpoints: configuredReadEndpoints,
  sessionStore: payrollSession,
  transport: readOnlyTransport,
  parsers: tenantSpecificParsers,
});

try {
  await syncPayroll({ provider: payroll, store, householdId, period });
  await syncPaystubs({ provider: payroll, store, householdId, since });
} finally {
  payrollSession.clear();
}
```

The endpoints and parsers remain injected because UKG tenants differ. Do not
invent a password/login flow when a fresh runtime browser session is available.
