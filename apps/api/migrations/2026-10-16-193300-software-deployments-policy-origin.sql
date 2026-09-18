-- apps/api/migrations/2026-10-16-193300-software-deployments-policy-origin.sql
--
-- Feature #5505 (desired-state software install) W03 / #5508, cross-wave
-- contract D7. Marks a software_deployments row as created BY a software
-- policy's autoInstall remediation rather than by an operator, so:
--   * the remediation worker can dedupe in-flight policy-owned work on the
--     DEPLOYMENT row (the uninstall dedup in softwareRemediationWorker.ts pins
--     device_commands.type = software_uninstall and cannot see installs);
--   * the deployment list can label the row as policy-owned (W04).
--
-- The column is stamped by the INSERT in createSoftwareDeployment, never
-- patched onto an existing row.
--
-- WHY ON DELETE SET NULL — this is load-bearing, not style. software_policies
-- is in CORE_ORG_CASCADE_DELETE_ORDER and a PARTNER-WIDE policy (org_id NULL,
-- partner_id set) is referenced by policy-owned deployments in EVERY child org
-- of that partner. With the NO ACTION default that the two sibling FKs
-- (software_version_id, install_method_id) use, deleting such a policy —
-- including the cascade's own DELETE FROM software_policies — would abort an
-- org or partner erasure with 23503 the moment one deployment row outlived its
-- policy. SET NULL degrades the label instead of aborting the purge. Ordering
-- is ALSO fine on its own (software_deployments sorts before software_policies
-- in CORE_ORG_CASCADE_DELETE_ORDER, and the org pre-clear in tenantCascade.ts
-- empties software_deployments before the main loop runs), but SET NULL is what
-- makes the cross-org partner-wide case safe.
--
-- NOT a composite (x, org_id) FK, so CLAUDE.md's "every composite FK that
-- references an org_id column MUST be DEFERRABLE INITIALLY IMMEDIATE" rule does
-- NOT apply: org merge runs SET CONSTRAINTS ALL DEFERRED and re-points org_id
-- on parent and child in separate statements, and never touches this column.
-- Do not add DEFERRABLE.
--
-- Export policy: software_policy_id is classified 'included' (a tenant row
-- identifier, no secret material — same treatment as the existing
-- maintenance_window_id and created_by FKs on this table) in
-- CORE_TENANT_EXPORT_POLICY in this same PR. software_deployments is an
-- org-cascade table, so every one of its columns must be classified, and
-- tenant-export-policy.integration.test.ts fails on an unclassified ADD COLUMN.
--
-- RLS: software_deployments is shape 1 (direct org_id) and its policies are
-- unchanged — a new column does not change the shape, so
-- rls-coverage.integration.test.ts needs no allowlist entry.
--
-- DDL ONLY: no UPDATE / DELETE / INSERT / MERGE, so no
-- `SELECT set_config('breeze.scope','system',true);` elevation is required
-- (migrationRlsScope.test.ts only flags files that write rows).
--
-- Idempotent: IF NOT EXISTS on the column and the index, and a duplicate_object
-- guard on the constraint (the same shape as
-- 2026-08-16-b-software-deployments-install-method.sql). Re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in its own transaction.

ALTER TABLE software_deployments
  ADD COLUMN IF NOT EXISTS software_policy_id uuid;

DO $$ BEGIN
  ALTER TABLE software_deployments
    ADD CONSTRAINT software_deployments_software_policy_id_fkey
    FOREIGN KEY (software_policy_id) REFERENCES software_policies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS software_deployments_software_policy_idx
  ON software_deployments (software_policy_id);
