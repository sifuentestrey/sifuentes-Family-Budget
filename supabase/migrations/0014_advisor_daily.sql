-- Daily automated check-in: advisor-daily writes into the same advisor_notes
-- table advisor-note already uses, tagged so the UI (and the "don't repeat
-- yourself" prompt context) can tell an unprompted nightly note from one the
-- household asked for directly.

alter table advisor_notes
  add column source text not null default 'manual'
  check (source in ('manual', 'daily'));
