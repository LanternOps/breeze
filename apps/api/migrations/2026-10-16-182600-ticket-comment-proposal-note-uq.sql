-- #4211 (W01) review fix: at most one technician-posted proposal note per
-- triage run, mirroring ticket_comments_one_ai_note_per_run_uq's idempotency
-- contract for the agent-authored lane (2026-09-25-ai-agents-ticket-triage.sql).
--
-- Without this, postProposalNote() (ticketService.ts) has no protection
-- against a duplicate INSERT: if a failure lands AFTER the ticket_comments
-- insert commits but BEFORE the route responds (e.g. the outbox write or
-- audit-log call throws), the client sees an error and the technician's
-- retry — using the SAME runId — creates a second, identical private note
-- attributed to them. postProposalNote() now catches the resulting unique
-- violation and returns the EXISTING row, same recovery shape as
-- addAiTriageNote() immediately above it in ticketService.ts.
--
-- No DML in this file, so the migrationRlsScope guard has nothing to elect
-- system scope for.

CREATE UNIQUE INDEX IF NOT EXISTS ticket_comments_one_proposal_note_per_run_uq
  ON ticket_comments (proposed_by_run_id)
  WHERE proposed_by_run_id IS NOT NULL AND origin_principal_kind = 'user';
