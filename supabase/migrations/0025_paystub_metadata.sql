-- Provider paystubs carry useful non-secret context that improves forecasts
-- and reconciliation: employer/pay group, pay rate, PTO balance, advice/check
-- number, and YTD totals. Authentication cookies are never stored here.

alter table paystubs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column paystubs.metadata is
  'Non-secret paystub metadata only. Never store provider cookies or session tokens.';
