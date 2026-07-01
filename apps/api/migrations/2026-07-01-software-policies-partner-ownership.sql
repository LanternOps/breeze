-- Partner-owned software policies (epic #2135, issue #2126).
--
-- Until now a software_policies row was always owned by exactly one org
-- (org_id NOT NULL), so a software blocklist/allowlist could not be defined
-- once and applied across every org under a partner — an MSP had to recreate
-- and maintain a copy per customer. This migration makes a software policy
-- ownable by EITHER an org (org_id set, partner_id NULL — the existing shape)
-- OR a partner (partner_id set, org_id NULL — the "partner-wide / all orgs"
-- template shape), enforced by an exactly-one-axis CHECK. This mirrors
-- configuration_policies (2026-06-27-config-policies-partner-ownership.sql)
-- and patch_policies (partner-axis update rings).
--
-- software_policy_audit is dual-owned but NOT XOR: an event for a partner-wide
-- policy acting on a device carries BOTH the device's org_id (org admin
-- visibility) and the policy's partner_id (partner admin visibility);
-- policy-level events carry whichever axis owns the policy. CHECK requires at
-- least one axis.
--
-- software_compliance_status is unchanged: it reaches its tenant through the
-- device join (devices are always org-owned), which is correct for partner-wide
-- policies too — each compliance row belongs to the device's own org.
--
-- RLS: both tables move from pure org-axis (0039-software-policies-rls.sql) to
-- dual-axis (org OR partner) with the system short-circuit, matching the
-- configuration_policies precedent.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECKs, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — software_policies: add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE software_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE software_policies
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set. (org_id IS NULL) <> (partner_id IS NULL)
-- is true iff exactly one of the two is NULL — i.e. exactly one is set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_policies_one_owner_chk'
      AND conrelid = 'software_policies'::regclass
  ) THEN
    ALTER TABLE software_policies
      ADD CONSTRAINT software_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_policies_partner_id_idx
  ON software_policies(partner_id);

-- ============================================
-- Step 2: schema — software_policy_audit: add partner_id, relax org_id,
--         at-least-one-owner CHECK (NOT XOR — see header)
-- ============================================

ALTER TABLE software_policy_audit
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE software_policy_audit
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_policy_audit_owner_chk'
      AND conrelid = 'software_policy_audit'::regclass
  ) THEN
    ALTER TABLE software_policy_audit
      ADD CONSTRAINT software_policy_audit_owner_chk
      CHECK (org_id IS NOT NULL OR partner_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_policy_audit_partner_id_idx
  ON software_policy_audit(partner_id);

-- ============================================
-- Step 3: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================
-- Replaces the four pure org-axis policies per table from
-- 0039-software-policies-rls.sql with a single dual-axis policy each,
-- matching the configuration_policies shape. ENABLE/FORCE are re-asserted
-- for idempotence (0039 already set them).

ALTER TABLE software_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_policies;
DROP POLICY IF EXISTS software_policies_isolation ON software_policies;
CREATE POLICY software_policies_isolation
  ON software_policies
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

ALTER TABLE software_policy_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_policy_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_policy_audit;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_policy_audit;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_policy_audit;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_policy_audit;
DROP POLICY IF EXISTS software_policy_audit_isolation ON software_policy_audit;
CREATE POLICY software_policy_audit_isolation
  ON software_policy_audit
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
