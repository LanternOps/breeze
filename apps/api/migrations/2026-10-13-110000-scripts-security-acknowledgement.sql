-- #5129 — per-script acknowledgement of the agent's STRICT-level script
-- security patterns.
--
-- Before this, `agent/internal/executor/executor.go` constructed its validator
-- at SecurityLevelStrict with no override reachable from anywhere in the
-- product, so `Set-ItemProperty ... HKLM` — routine MSP configuration work —
-- was an unconditional refusal at execution time. Strict patterns are now
-- acknowledgeable per script by someone who can already manage scripts; the
-- acknowledged descriptions ride the dispatch payload and the agent allows
-- exactly those. BASIC-level patterns (rm -rf /, Format-Volume, fork bombs,
-- block-device writes) remain unconditional and are NOT acknowledgeable.
--
-- `acknowledged_security_patterns` stores the SET OF PATTERN DESCRIPTIONS, not
-- a boolean. A boolean would mean acknowledging an HKLM write permanently
-- disarms Strict checking for that script, so a later edit that introduces a
-- credential-dumping pattern would inherit the approval silently. With the
-- set, the existing approval stands and the new pattern is unacknowledged and
-- still blocked. The API re-derives the stored set on every save as
-- (submitted ∩ patterns the content actually matches), so no caller can
-- pre-acknowledge the whole vocabulary — see
-- apps/api/src/services/scriptSecurityAcknowledgement.ts.
--
-- Registration (CLAUDE.md cascade tables): NOTHING to add beyond the export
-- policy. No new table — `scripts` is already in CORE_ORG_CASCADE_DELETE_ORDER
-- (tenantCascade.ts), the org-merge repoint list (orgMergeRegistry.ts), and
-- the partner-axis allowlist in rls-coverage.integration.test.ts. It has no
-- device_id, so neither device-side list applies. The three NEW COLUMNS are
-- classified in CORE_TENANT_EXPORT_POLICY (tenantExportPolicyRegistry.ts) in
-- this same PR — that registry fires on a new column, not just a new table.
--
-- RLS: unchanged. `scripts` already carries the dual-axis
-- breeze_dual_axis_{select,insert,update,delete} policies from
-- 2026-06-13-catalog-partner-axis-rls.sql; adding columns does not alter row
-- access. No `breeze.scope` elevation is needed here because this migration
-- writes no rows — ADD COLUMN ... DEFAULT does not rewrite existing tuples on
-- PostgreSQL 11+.

ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS acknowledged_security_patterns text[] NOT NULL DEFAULT '{}'::text[];

-- ON DELETE SET NULL, deliberately diverging from the sibling `created_by`
-- (which has no ON DELETE action). Deleting a user must not start failing on
-- an FK that only records attribution: the audit log is the forensic record
-- and survives independently, so dropping the pointer is the right trade.
ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS security_acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS security_acknowledged_at timestamp;

COMMENT ON COLUMN scripts.acknowledged_security_patterns IS
  'Agent STRICT-level danger-pattern descriptions acknowledged for this script (#5129). Dispatched with every run; the agent permits exactly these Strict patterns. BASIC-level patterns are never acknowledgeable. Re-derived on every save as (submitted ∩ actually-matching), so a newly-introduced pattern is unacknowledged and still blocks.';

COMMENT ON COLUMN scripts.security_acknowledged_by IS
  'User who granted the most recent security-pattern acknowledgement (#5129).';

COMMENT ON COLUMN scripts.security_acknowledged_at IS
  'When the most recent security-pattern acknowledgement was granted (#5129).';
