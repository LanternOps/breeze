-- #3189 — automation replay idempotency.
--
-- 1. `dispatching` on automation_action_result_status: the per-action claim.
--    The runtime moves a ledger row pending -> dispatching (CAS) inside the
--    same transaction that creates the action's effect and stamps its outcome,
--    so a BullMQ stalled-job replay finds the row already claimed and reuses
--    the stored commandId / scriptExecutionId instead of dispatching again.
--    Appended last: drizzle-kit compares enum order for drift.
--
-- 2. automation_runs.occurrence_key + two partial unique indexes: the trigger
--    occurrence (schedule slot, event id, config-policy schedule slot) a run
--    was minted for. A replayed trigger job hits the unique index and reuses
--    the existing run instead of creating a second one. NULL for manual,
--    webhook and subject-response runs, which are never deduplicated here.
--
-- automation_runs has no org_id column, so it is in neither
-- CORE_ORG_CASCADE_DELETE_ORDER nor CORE_TENANT_EXPORT_POLICY; its existing
-- RLS policies cover the new column. Every existing row gets NULL, which the
-- partial indexes exclude, so building them cannot fail on old data.
--
-- This migration writes no rows, so it needs no breeze.scope elevation.

ALTER TYPE automation_action_result_status ADD VALUE IF NOT EXISTS 'dispatching';

ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS occurrence_key varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_automation_occurrence_uq
  ON automation_runs (automation_id, occurrence_key)
  WHERE automation_id IS NOT NULL AND occurrence_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_config_policy_occurrence_uq
  ON automation_runs (config_policy_id, occurrence_key)
  WHERE automation_id IS NULL AND occurrence_key IS NOT NULL;
