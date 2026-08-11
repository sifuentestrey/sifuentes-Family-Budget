-- Direct questions to the advisor, not just the "+ Get a check-in" button.
-- Reuses advisor_notes rather than a separate table: a question-and-answer is
-- still a note with continuity into the same history the prompt already
-- rides on, it just also carries what was asked.

alter table advisor_notes
  add column question text;
