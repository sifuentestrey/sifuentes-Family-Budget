# Implementation Roadmap

This document is the handoff plan for the automation-first household budget.

## Current architecture

The repository is intentionally provider-agnostic. Provider credentials and secrets must never be committed.

Core flow:

`provider -> adapter -> normalized data -> validation/deduplication -> household domain -> forecasting/discovery -> UI`

## Household providers

| Provider | Data | Preferred path | Fallback |
|---|---|---|---|
| Bank of America | checking, transactions, balance | Plaid | none |
| Chase | checking, transactions, balance | Plaid | none |
| UKG | timecard | official employee-authorized API if available | email/paystub/manual import |
| UKG | paystub | official API if available | email/document ingestion |
| Pennymac | mortgage bill/balance | official customer connection if available | email + bank evidence |
| Advancial | auto-loan bill/balance | official customer connection if available | email + bank evidence |
| TVEC | electricity bill | verified provider integration | email + bank evidence |
| Watermark | water bill | verified provider integration | email + bank evidence |
| Gmail/Outlook | bills and paystubs | OAuth | none |

Provider names and URLs must be verified before implementing live adapters. Do not guess the TVEC or Watermark provider.

## Plaid guardrails

Plaid is for read-only financial aggregation. Never request payment/write products for this app.

The application should:

1. Prevent duplicate Items for the same household/institution where possible.
2. Keep access tokens server-side only.
3. Store sensitive tokens only in the approved secret/Vault mechanism.
4. Never log tokens or credentials.
5. Never return provider tokens to the browser.
6. Support disconnect/revocation.
7. Treat the free-tier Item limit as a scarce resource.

## Financial discovery

Transactions should be normalized before recurring detection. Discovery must distinguish:

- bill
- subscription
- debt payment
- transfer
- income
- discretionary recurring
- unknown

Credit-card payments and transfers must not be counted as household spending twice.

Recurring discovery should provide:

- normalized merchant
- average amount
- amount range
- frequency
- last seen
- next expected date
- confidence
- source account
- transaction evidence

Discovery is a candidate generator. The user can confirm/reject classifications, and confirmed classifications should be reusable.

## Pay forecast

The pay engine must separate:

- regular hours
- overtime
- callback
- standby
- holiday
- differential
- PTO
- deductions
- estimated withholding

For a 4x10 schedule, daily overtime must not be assumed merely because a shift exceeds eight hours. Overtime rules should be configurable rather than hard-coded.

The system should reconcile forecast vs actual paystub and learn an effective withholding/deduction profile over time.

## Bill ingestion

Email ingestion should use provider search/filtering and least-privilege OAuth. Do not indiscriminately copy an entire mailbox into the application.

Bill extraction should capture:

- provider/merchant
- amount due
- due date
- statement period
- source message/document identifier
- confidence

Duplicate messages/statements must not create duplicate obligations.

## Security acceptance criteria

Before connecting real accounts:

- no credentials in repository
- no provider tokens in browser bundles
- no provider tokens in logs
- row-level household isolation is enforced by the database
- service-role credentials remain server-side
- disconnect removes/invalidates provider access appropriately
- tests cover cross-household access attempts
- tests cover secret leakage patterns

## Recommended build order

1. Verify current database/RLS and deployed server functions.
2. Verify Plaid Link/token exchange without using real household credentials in source control.
3. Finish transaction normalization and recurring discovery.
4. Finish household onboarding/connection state.
5. Finish email OAuth + bill/paystub extraction.
6. Finish UKG timecard/paystub adapters based on the employer's actual available authorization/API surface.
7. Add Pennymac/Advancial/utility adapters only after official connection methods are verified.
8. Wire forecasts and safe-to-spend to the normalized household ledger.
9. Add end-to-end tests using fixtures only.
10. Connect real accounts last.
