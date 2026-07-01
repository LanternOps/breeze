-- Partner-owned security policies (epic #2135, issue #2127).
--
-- Until now a security_policies row was always owned by exactly one org
-- (org_id NOT NULL), so an AV/EDR baseline (scan schedule, real-time
-- protection, quarantine, severity threshold, exclusions) could not be defined
-- once and applied across every org under a partner. This migration makes a
-- security policy ownable by EITHER an org (org_id set, partner_id NULL — the
-- existing shape) OR a partner (partner_id set, org_id NULL — the
-- "partner-wide / all orgs" template shape), enforced by an exactly-one-axis
-- CHECK. Mirrors software_policies (2026-07-01-software-policies-partner-
-- ownership.sql) and configuration_policies (#1724).
--
-- Simpler than the software_policies migration: security_policies is a LEAF —
-- no child/audit table FK-references it, and the posture tables
-- (security_status/threats/scans/posture_snapshots) reach tenancy through the
-- device's own org, never through a policy row, so they are unchanged.
--
-- RLS: replaces the four legacy per-command breeze_org_isolation_* policies
-- (0001-baseline) with a single dual-axis policy + system short-circuit,
-- matching the software_policies / configuration_policies shape. FORCE was not
-- asserted for this table in the baseline; assert ENABLE + FORCE here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE security_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE security_policies
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set. (org_id IS NULL) <> (partner_id IS NULL)
-- is true iff exactly one of the two is NULL — i.e. exactly one is set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'security_policies_one_owner_chk'
      AND conrelid = 'security_policies'::regclass
  ) THEN
    ALTER TABLE security_policies
      ADD CONSTRAINT security_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS security_policies_partner_id_idx
  ON security_policies(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================

ALTER TABLE security_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON security_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON security_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON security_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON security_policies;
DROP POLICY IF EXISTS security_policies_isolation ON security_policies;
CREATE POLICY security_policies_isolation
  ON security_policies
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
