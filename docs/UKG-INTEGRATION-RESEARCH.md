# UKG Integration Research

Updated 2026-08-10 from the current UKG Developer Hub documentation.

## What UKG exposes

UKG has separate product surfaces for Pro HCM and Pro WFM. Pro HCM covers payroll/HR data; Pro WFM covers punches, shifts, scheduling, accruals, and time data.

The exact API available to an employee depends on the employer's tenant, product, roles, and permissions. Do not assume that an individual employee can self-authorize every API used by an administrator.

## Relevant integration paths

### UKG Pro WFM

For timecard data, UKG documents API access to labor/time data. The current UKG Developer Hub also documents a Dimensions-style REST pattern for timecard/labor queries, including actual worked hours.

The application should therefore model a UKG WFM adapter around normalized time entries rather than scraping the employee portal.

### UKG Pro HCM / payroll

Payroll and employee data are exposed through the Pro HCM developer platform, but available permissions are tenant-controlled. Pay statements may also exist as employee documents depending on the employer's UKG products/modules.

### HR Service Delivery / documents

UKG HR Service Delivery has REST APIs for searching and retrieving employee documents. This may provide a useful paystub/document path when the employer uses that product, but it is not proof that a particular employee's paystubs are available there.

## Recommended architecture

`UKG WFM -> UKGTimeProvider -> normalized TimeEntry -> pay engine`

`UKG payroll/pay documents -> UKGPayrollProvider -> normalized Paystub -> reconciliation`

If the employer's tenant does not permit employee-authorized API access:

`UKG/email/document export -> ingestion adapter -> normalized TimeEntry/Paystub`

Do not use browser automation unless the official/API and email/document paths are unavailable.

## Credential/security requirements

UKG API credentials must remain server-side. Never put employee passwords, API client secrets, access tokens, or refresh tokens in source control or browser code.

Where OAuth is supported, use the narrowest available scopes and server-side token storage. Where an employer-provisioned API credential is required, treat it as an administrator-managed integration rather than pretending it is a consumer OAuth connection.

## What the app should request from UKG

Timecard:
- pay period start/end
- shift date
- clock-in/out where permitted
- regular hours
- overtime hours
- callback/callout hours if represented
- standby/on-call hours if represented
- PTO/holiday hours
- approval/submission status
- source record identifier

Paystub:
- pay date
- pay period
- regular earnings
- overtime earnings
- callback/standby earnings if separately represented
- differentials
- gross pay
- taxes/withholding
- deductions
- net pay

## Important limitation

The app should not claim a UKG connection is possible until the actual employer tenant/product and employee permissions are verified. The current code should keep UKG as an adapter boundary and support email/document fallback.
