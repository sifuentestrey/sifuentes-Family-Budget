# Household connectors

## What can be connected now

The app already forecasts net pay from its pay profile and time entries. This
feature adds a stable ingestion boundary for:

- UKG/timekeeping CSV exports (server-side parsing)
- provider API adapters when an employer or utility provider grants approved API access
- email/PDF bill imports
- bank-transaction matching as a fallback for utility history

## Paycheck flow

1. Import UKG/timecard rows into time_entries.
2. Re-run the existing forecastPaycheck() for the active pay period.
3. Reconcile against the actual paystub.
4. reconcile.js learns the household's tax/deduction adjustment over time.

The app should show estimated net, actual-to-date, and projected remainder as
separate values. It should never present a partial timecard projection as money
already earned.

## Utility flow

1. Normalize TVEC electric and Watermark water bills into UtilityBill.
2. Keep the original source and sourceRef on every row.
3. Use forecastUtility() for the target month.
4. Allocate utilityPlanningAmount(forecast, 'reserve') to the paycheck plan.
5. When the bill arrives, replace the estimate with the actual and retain the
   variance for future confidence.

The displayed amount should be:

- Expected: median-based estimate
- Plan for: upper-quartile/recent-high reserve
- Typical range: observed 25th–75th percentile

## Security boundary

There is no universal, safe public UKG/TVEC/Watermark login API that the browser
can simply use for every household. A production connector must be approved by
the provider/employer and run server-side with secrets in Supabase Vault. The
browser should only receive normalized rows and sync status.

Until those approvals exist, imports and transaction matching are the correct
fallback—not password scraping.
