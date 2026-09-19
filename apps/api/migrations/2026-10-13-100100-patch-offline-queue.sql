-- 2026-10-13-100100: patch installs queue for offline devices (#5128 W3).
--
-- 'queued' = an install_patches command has been persisted with a deliver_by and
-- is waiting for the device's next heartbeat. patch_jobs.devices_queued keeps
-- the job non-terminal while any device is still waiting to reconnect, so
-- unfinished patching is never reported as completed (#5128 §F.3, OD-9).
--
-- config_policy_patch_settings has no org_id/partner_id — its tenancy is
-- transitive via feature_link_id -> config_policy_feature_links ->
-- configuration_policies (dual-axis) — so this adds no RLS policy, no cascade
-- entry and no export-policy entry, exactly like the #3207 reboot-deferral
-- columns beside it. patch_jobs IS an org-cascade table, so devices_queued is
-- classified in CORE_TENANT_EXPORT_POLICY (`included`) in the same PR.
--
-- DDL only: no UPDATE/DELETE/INSERT, so no breeze.scope elevation is required.

ALTER TYPE patch_job_result_status ADD VALUE IF NOT EXISTS 'queued';

ALTER TABLE patch_jobs
  ADD COLUMN IF NOT EXISTS devices_queued integer NOT NULL DEFAULT 0;

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS offline_behavior varchar(20) NOT NULL DEFAULT 'queue';

DO $$ BEGIN
  ALTER TABLE config_policy_patch_settings
    ADD CONSTRAINT config_policy_patch_settings_offline_behavior_chk
    CHECK (offline_behavior IN ('skip', 'queue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
