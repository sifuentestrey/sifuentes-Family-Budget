-- Utility history for seasonal bill forecasting.
-- Reuses the existing household-scoped bills table so imported TVEC/Watermark
-- rows remain the same bills used by due-date and paycheck allocation.

alter table bill_sources
  add column if not exists utility_type text
    check (utility_type is null or utility_type in ('water', 'electric', 'gas', 'internet', 'other'));

alter table bills
  add column if not exists utility_type text
    check (utility_type is null or utility_type in ('water', 'electric', 'gas', 'internet', 'other')),
  add column if not exists usage numeric(14,3)
    check (usage is null or usage >= 0),
  add column if not exists usage_unit text;

create index if not exists bills_utility_history_idx
  on bills (household_id, provider_key, utility_type, due_date desc)
  where utility_type is not null;

comment on column bills.utility_type is
  'Normalized utility type used by seasonal forecasting; null for non-utility bills';
comment on column bills.usage is
  'Provider-reported usage when present, retained for future weather/usage models';
comment on column bills.usage_unit is
  'Unit accompanying usage, for example kWh or gallons';
