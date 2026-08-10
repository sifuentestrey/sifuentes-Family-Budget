# Account Connection Checklist

Use this checklist before connecting any real household account.

## Bank accounts

- [ ] Bank of America — checking
- [ ] Chase — wife's checking

For each Plaid Item:

- [ ] Institution is correct
- [ ] Account(s) selected are correct
- [ ] Read-only access only
- [ ] No duplicate existing Item
- [ ] Last sync timestamp recorded
- [ ] Disconnect path tested

## Payroll

- [ ] UKG employer instance identified
- [ ] Timekeeping product identified
- [ ] Payroll product identified
- [ ] Employee self-service API/OAuth availability verified
- [ ] Timecard fields mapped
- [ ] Paystub fields mapped
- [ ] Email fallback available if direct API access is unavailable

## Bills

- [ ] Pennymac mortgage provider identity verified
- [ ] Advancial loan provider identity verified
- [ ] Exact TVEC provider identity verified
- [ ] Exact Watermark provider identity verified
- [ ] Gmail/Outlook provider identified
- [ ] OAuth scopes minimized
- [ ] Bill/paystub searches restricted to relevant mail

## Security

Never put any of these in GitHub:

- bank passwords
- Plaid client secrets
- Plaid access tokens
- refresh tokens
- email OAuth secrets
- UKG credentials
- utility credentials
- loan credentials
- exported statements containing personal financial data

Real credentials belong in the deployment platform's secret manager/Vault, not source files or `.env` files committed to the repository.
