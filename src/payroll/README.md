# Payroll engine

The payroll layer is designed to make paycheck forecasting automatic.

## Flow

1. A payroll/timecard connector retrieves the current pay-period entries.
2. `estimatePay()` calculates regular, overtime, callback, standby and other earnings.
3. Recurring deductions and an estimated tax withholding rate produce an estimated net paycheck.
4. A paystub connector can retrieve the actual check and `compareToActual()` measures the variance.
5. Historical actual checks can later be used to improve forecasting.

## Important integration rule

Do not put employer payroll usernames/passwords in source code or the database. Prefer OAuth, official APIs, secure session tokens, or a provider-supported integration. If the payroll provider has no supported API, the connector can be implemented separately without changing the calculation engine.

## Example

```ts
const estimate = estimatePay(profile, period, timeEntries);
// estimate.estimatedNetPay -> amount the budget can expect
```

The connector layer is intentionally provider-neutral so the app can later support the employer's specific timekeeping/payroll platform without rewriting the budget logic.
