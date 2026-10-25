-- Wisp W08 (#9914, feature #9906; w00 A35): the partner enable switch.
--
-- Spec §17.2 (4): the entitlement is commercial, this switch is governance,
-- BREEZE_WISP_ENABLED is the deployment kill switch — none overrides another.
-- `enabled = false` makes createGrant refuse (403 partner_disabled) and the
-- W05 wake tick pause the partner's active grants with reason
-- 'partner_disabled' (already in wisp_grants_paused_reason_chk); re-enabling
-- resumes only grants paused with that reason.
--
-- A column on W06's one partner settings row (w00 A35 "folds into the same
-- row"), not a new table. A missing row means enabled (the DEFAULT). The
-- table's existing RLS policy (system OR breeze_has_partner_access) and
-- grants already cover the new column. No org_id → no cascade / merge /
-- export registration (same as the W06 migration that created the table).
--
-- DDL only — writes no rows, so no breeze.scope election. Idempotent; no
-- inner BEGIN/COMMIT (autoMigrate wraps the file).
ALTER TABLE wisp_partner_nudge_settings
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
