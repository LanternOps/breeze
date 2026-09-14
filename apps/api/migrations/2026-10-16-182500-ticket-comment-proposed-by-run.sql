-- #4211 (W01): provenance for a note a HUMAN posted from an AI proposal.
--
-- Deliberately NOT ticket_comments.agent_run_id: that column means "an agent
-- run wrote this row", and the helpdesk loop guard
-- (ticketHelpdeskSubscriber.ticketHasAgentOriginatedActivity) treats a non-null
-- agent_run_id as agent-originated activity and refuses to re-admit. A note the
-- technician posted under their own identity is human activity; recording the
-- run here keeps the loop guard's meaning intact while preserving the "which
-- run's text was this" link that #4182 (measured time saved) will need.
--
-- No DML in this file, so the migrationRlsScope guard has nothing to elect
-- system scope for.

ALTER TABLE ticket_comments
  ADD COLUMN IF NOT EXISTS proposed_by_run_id uuid;

-- FK declared in SQL only: db/schema/aiAgents.ts already imports `tickets` from
-- portal.ts, so a .references() here would be a circular module import — same
-- reason agent_run_id's FK lives only in SQL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_proposed_by_run_id_fkey'
  ) THEN
    ALTER TABLE ticket_comments
      ADD CONSTRAINT ticket_comments_proposed_by_run_id_fkey
      FOREIGN KEY (proposed_by_run_id) REFERENCES ai_agent_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_comments_proposed_by_run_idx
  ON ticket_comments (proposed_by_run_id)
  WHERE proposed_by_run_id IS NOT NULL;
