# Hermes Browser Sync

Hermes is the read-only browser bridge for provider portals that do not offer a practical API. It reads normalized financial facts from authenticated pages and sends only those facts to the `hermes-ingest` Supabase Edge Function. The Edge Function is the writer and enforces validation, deduplication, and audit logging.

## Security boundary

- Hermes may browse and read supported portals. It must not pay bills, submit timecards, change benefits, edit payroll, transfer money, or modify account settings.
- The user handles the first login, MFA, CAPTCHA, forced reauthentication, and password changes.
- Never put passwords, MFA codes, cookies, session storage, raw portal HTML, the Supabase service-role key, or the Hermes bearer token in GitHub or in an ingestion payload.
- The local bridge only receives the dedicated `FAMILY_BUDGET_HERMES_TOKEN`. Supabase keeps the matching server-side secret in Vault as `hermes_ingest_secret`.
- If a session expires, stop that source and report `needs_reauth`; do not guess credentials or repeatedly retry authentication.

## Persistent browser

In `~/.hermes/config.yaml`, enable the managed Camofox profile:

```yaml
browser:
  camofox:
    managed_persistence: true
```

Use one dedicated Hermes browser profile for the family-budget integrations. Log into each provider interactively once. Persistent sessions reduce repeated logins but do not bypass a provider's MFA or session-expiration rules.

## Local bridge environment

The bridge is `scripts/hermes-push.mjs`. Keep the token in the local process environment only:

```bash
export FAMILY_BUDGET_HERMES_TOKEN='...local secret...'
```

Optional overrides:

```bash
export FAMILY_BUDGET_HERMES_URL='https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/hermes-ingest'
export FAMILY_BUDGET_HOUSEHOLD_ID='953f317d-5d02-4c72-b94a-6bef16b42937'
```

Send a payload from a file:

```bash
node scripts/hermes-push.mjs /tmp/family-budget-payload.json
```

Or pipe JSON on stdin:

```bash
cat /tmp/family-budget-payload.json | node scripts/hermes-push.mjs
```

The helper exits non-zero if the endpoint rejects the delivery, making it suitable for Hermes cron jobs.

## Provider contract

Every delivery has this envelope:

```json
{
  "provider_key": "hermes_ukg",
  "provider_name": "UKG / Texas Health",
  "kind": "payroll",
  "observed_at": "2026-08-21T13:30:00Z",
  "context": {},
  "records": []
}
```

`household_id` is added by the local helper if omitted. Maximum batch size is 250 records.

### UKG timecard

Use `kind: "payroll"`. Use the existing Texas Health pay profile when an explicit profile is needed:

```json
{
  "provider_key": "hermes_ukg",
  "provider_name": "UKG / Texas Health",
  "kind": "payroll",
  "context": {
    "pay_profile_id": "cc724f27-199b-4185-885b-4162ef18cd74",
    "period_start": "YYYY-MM-DD",
    "period_end": "YYYY-MM-DD",
    "pay_date": "YYYY-MM-DD",
    "period_status": "open"
  },
  "records": [
    {
      "external_id": "ukg:PERIOD_START:ENTRY_DATE",
      "entry_date": "YYYY-MM-DD",
      "start_time": "07:00",
      "end_time": "17:30",
      "regular_hours": 10,
      "overtime_hours": 0,
      "standby_hours": 0,
      "callback_hours": 0,
      "callback_events": 0,
      "holiday_hours": 0,
      "pto_hours": 0,
      "differential_code": null,
      "differential_hours": 0
    }
  ]
}
```

Rules:

- Prefer the portal's explicit hour buckets over calculating them from clock times.
- Do not transform a normal 10-hour shift into daily overtime; the app's pay profile handles its own payroll rules.
- `external_id` must stay stable across rereads so a corrected timecard updates the same day instead of duplicating it.
- One time entry is stored per pay profile per date; overlapping daily sync windows are expected.

### Paystub

Use `kind: "paystubs"`:

```json
{
  "provider_key": "hermes_texas_health_paystub",
  "provider_name": "Texas Health Payroll",
  "kind": "paystubs",
  "context": {
    "pay_profile_id": "cc724f27-199b-4185-885b-4162ef18cd74"
  },
  "records": [
    {
      "external_id": "ukg-paystub:PAY_DATE:PERIOD_START",
      "pay_date": "YYYY-MM-DD",
      "period_start": "YYYY-MM-DD",
      "period_end": "YYYY-MM-DD",
      "gross_pay": 0,
      "net_pay": 0,
      "total_taxes": 0,
      "regular_hours": 0,
      "overtime_hours": 0,
      "earnings": {},
      "deductions": [
        { "label": "Example", "amount": 0, "pre_tax": false, "category": "Other" }
      ],
      "confidence": 0.99
    }
  ]
}
```

The endpoint rejects a net amount above gross, links the stub to its pay period, and replaces the deduction breakdown when a newer reading of the same stub is delivered.

### Bill portal

Use `kind: "bills"`:

```json
{
  "provider_key": "hermes_tvec",
  "provider_name": "TVEC",
  "kind": "bills",
  "records": [
    {
      "external_id": "tvec:STATEMENT_OR_DUE_DATE:AMOUNT",
      "provider_name": "TVEC",
      "category": "Utilities",
      "account_label": "1234",
      "amount_due": 0,
      "currency": "USD",
      "due_date": "YYYY-MM-DD",
      "statement_date": "YYYY-MM-DD",
      "status": "detected",
      "confidence": 0.98
    }
  ]
}
```

Never send a full account number. `account_label` is limited to 8 characters and should normally be the last four digits only. Bills are deduplicated both by stable source ID and by provider + due date + amount.

## Daily Hermes job

After the persistent profile is confirmed for a source, create a daily Hermes cron job that:

1. Opens the provider portal using the persistent browser profile.
2. If authentication is still valid, reads only the fields required by the contract above.
3. Creates stable `external_id` values from provider-native IDs when available; otherwise use deterministic period/date identifiers.
4. Writes the normalized envelope to a temporary JSON file.
5. Runs `node scripts/hermes-push.mjs <file>` from the repository.
6. Deletes the temporary payload after a successful delivery.
7. If login/MFA is required, stops and reports that the source needs reauthentication rather than attempting to bypass it.

Recommended starting cadence: once each morning in `America/Chicago`, plus an on-demand run after a known timecard or bill change. More frequent reads are unnecessary unless a source genuinely changes intraday.

## Current live endpoint

`https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/hermes-ingest`

Supported writes: `bills`, `payroll`, `paystubs` only. Each run is recorded in `sync_runs`, and replaying the same source data is expected to count as a duplicate rather than create a second financial record.
