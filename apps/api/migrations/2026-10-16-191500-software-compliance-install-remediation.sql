-- apps/api/migrations/2026-10-16-191500-software-compliance-install-remediation.sql
-- Feature #5505 W02 (#5507), contract D1: a SECOND remediation-status axis on
-- software_compliance_status, for the `missing`-violation install verb.
--
-- WHY THREE COLUMNS AND NOT A JSONB BLOB. remediation_status is a single
-- varchar today and two verbs sharing it would lie: a successful install
-- alongside a failed uninstall has no honest single value. Separate columns
-- leave every existing uninstall read/write and the uninstall cooldown logic
-- byte-for-byte untouched, which a jsonb reshape would not.
--
-- install_remediation_attempts is the CONSECUTIVE attempt counter behind the
-- install-loop guard (spec Risks §1): a policy whose rule never matches what
-- the installer actually registers in Add/Remove Programs would otherwise
-- re-detect `missing` and reinstall every 15 minutes forever. It resets to 0
-- when the (policy, device) has no `missing` violation left and increments on
-- every queue; at SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS the compliance
-- worker stops and writes install_remediation_status = 'gave_up'.
--
-- Types deliberately mirror the existing remediation_status /
-- last_remediation_attempt columns (schema/softwarePolicies.ts): varchar(20)
-- and a bare `timestamp`, NOT timestamptz. Allowed status values are a
-- TypeScript union, not a DB enum, matching how remediation_status is already
-- constrained: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed' |
-- 'gave_up' | 'skipped'.
--
-- NO REGISTRATION CHANGES ARE NEEDED, verified: software_compliance_status has
-- no org_id column, appears zero times in services/tenantCascade.ts and zero
-- times in services/tenantExportPolicyRegistry.ts, and is already listed in
-- CORE_DEVICE_CASCADE_DELETE_TABLES (routes/devices/core.ts). It is
-- deliberately absent from CORE_DEVICE_ORG_DENORMALIZED_TABLES (documented as
-- such in routes/devices/core.ts).
--
-- DDL ONLY. No UPDATE/DELETE/INSERT/MERGE, so no
-- `SELECT set_config('breeze.scope','system',true);` is required (#4518 guard,
-- src/db/migrationRlsScope.test.ts). Idempotent: ADD COLUMN IF NOT EXISTS on
-- all three, so re-applying is a true no-op. No inner BEGIN/COMMIT — autoMigrate
-- already wraps each file in client.begin(...).
--
-- Note on existing rows: PostgreSQL 11+ materialises the DEFAULT for existing
-- rows via attmissingval without a table rewrite, so every pre-existing row
-- reads back 'none' / NULL / 0 immediately. That is the intended starting
-- state, identical to a freshly inserted row.

ALTER TABLE software_compliance_status
  ADD COLUMN IF NOT EXISTS install_remediation_status varchar(20) DEFAULT 'none';

ALTER TABLE software_compliance_status
  ADD COLUMN IF NOT EXISTS last_install_remediation_attempt timestamp;

ALTER TABLE software_compliance_status
  ADD COLUMN IF NOT EXISTS install_remediation_attempts integer NOT NULL DEFAULT 0;
