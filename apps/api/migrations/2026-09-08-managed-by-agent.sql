-- AI agents wave 3d (#3824): automations managed by an AI agent.
--
-- managed_by_agent_id marks an automation as the seeded trigger wiring for an
-- agent (spec §2 wave-3 row): its trigger/actions are system-maintained, the
-- ai_triage action resolves its agent through this column, and user edits are
-- rejected at the route layer. NULL = ordinary user automation.
--
-- ON DELETE RESTRICT: agents are never hard-deleted (spec §2); if that ever
-- changes, the managed automation must be dealt with explicitly, not
-- silently orphaned.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS managed_by_agent_id UUID
    REFERENCES ai_agents(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS automations_managed_by_agent_id_idx
  ON automations (managed_by_agent_id)
  WHERE managed_by_agent_id IS NOT NULL;

-- One managed automation per agent: the seeder upserts against this.
CREATE UNIQUE INDEX IF NOT EXISTS automations_managed_by_agent_uq
  ON automations (managed_by_agent_id)
  WHERE managed_by_agent_id IS NOT NULL;
