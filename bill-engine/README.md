# Family Budget Bill Engine

This is the automation layer for the family budget app.

## Goal

Automatically discover household bills, determine the current amount due and due date, and sync them into the budget with as little user interaction as possible.

## Source priority

1. **Email** — first implementation target. Detect bill/statement emails and extract the amount and due date.
2. **Official provider APIs/integrations** — preferred when a utility supports them.
3. **Authorized provider portals** — use an authorization flow where available; do not store provider passwords in source code or the database.
4. **Manual** — fallback only when automation cannot obtain a reliable value.

## Important behavior

- The app should be able to update an existing bill rather than creating duplicates.
- A bill should retain its source and external/message ID so imports are idempotent.
- Amounts should be stored as numeric USD values, not formatted strings.
- Low-confidence extraction should be flagged internally rather than silently changing a budget number.
- Credentials, OAuth tokens, refresh tokens, and provider secrets must never be committed to GitHub.

## Planned pipeline

```text
Email / Provider Connector
          ↓
   Source Normalizer
          ↓
 Provider Detection
          ↓
   Bill Extraction
          ↓
 Duplicate / Existing Bill Check
          ↓
   Budget Bill Record
          ↓
 Forecast + Alerts + Dashboard
```

## Next implementation steps

- Add a Gmail/Outlook connector with OAuth.
- Add email search rules for bill/statement/payment messages.
- Parse HTML emails and PDF attachments.
- Add provider-specific extraction rules after the generic parser.
- Add a scheduled sync endpoint/job.
- Add automatic paid-status detection from payment confirmation emails.
- Add anomaly detection against the household's historical bill amounts.
