-- Backfill mis-keyed config-policy automation runs (issue #1855).
--
-- `createConfigPolicyAutomationRun` historically stored
-- `config_policy_feature_links.id` (the feature-link id) into
-- `automation_runs.config_policy_id`, but every consumer treats that column as a
-- `configuration_policies.id`:
--   * the RLS EXISTS-join (2026-05-30-fk-child-tables-rls.sql) joins
--     configuration_policies on cp.id = automation_runs.config_policy_id, and
--   * the read route joins configurationPolicies on run.config_policy_id.
-- A feature-link id matches no configuration_policies row, so those runs were
-- RLS-invisible to org-scoped readers and 404'd in the portal even though the
-- INSERT succeeded under the worker's system db context.
--
-- The code fix resolves the owning configuration_policies.id before insert.
-- This migration remaps the existing bad rows: config-policy runs
-- (automation_id IS NULL) whose config_policy_id is in fact a feature-link id
-- are rewritten to that link's configuration_policies.id.
--
-- Idempotent: re-running is a no-op because the WHERE clause only matches rows
-- whose config_policy_id still equals a config_policy_feature_links.id (and the
-- guard excludes ids that are already a valid configuration_policies.id, so a
-- feature-link id that happens to collide with a policy id is left untouched).
-- No inner BEGIN/COMMIT — autoMigrate wraps the file in a transaction.

DO $$
DECLARE
  remapped bigint;
BEGIN
  UPDATE automation_runs ar
  SET config_policy_id = fl.config_policy_id
  FROM config_policy_feature_links fl
  WHERE ar.automation_id IS NULL
    AND ar.config_policy_id = fl.id
    -- Only touch rows that are NOT already a valid policy id, so a run already
    -- pointing at a real configuration_policies.id is never disturbed.
    AND NOT EXISTS (
      SELECT 1 FROM configuration_policies cp WHERE cp.id = ar.config_policy_id
    );

  GET DIAGNOSTICS remapped = ROW_COUNT;
  IF remapped > 0 THEN
    RAISE WARNING 'config-policy-run-tenant-key-backfill: remapped % automation_runs rows from feature-link id to configuration_policies.id (#1855)', remapped;
  END IF;
END $$;
