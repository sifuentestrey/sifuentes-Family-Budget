-- Soft financial advisor: a household-visible history of the check-in notes
-- advisor-note generates, so the advisor has continuity ("last time I flagged
-- X") instead of being stateless on every call, and so past notes are a
-- normal RLS-scoped table like everything else here, not something that
-- only exists in the model's context window for one request.

create table advisor_notes (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  note          text not null,
  created_at    timestamptz not null default now()
);

create index on advisor_notes (household_id, created_at desc);

alter table advisor_notes enable row level security;

create policy advisor_note_access on advisor_notes
  for all using (household_id in (select current_household_ids()))
  with check (household_id in (select current_household_ids()));
