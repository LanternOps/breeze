-- Partner-owned maintenance windows (epic #2135, issue #2131).
--
-- Until now a maintenance_windows row was always owned by exactly one org
-- (org_id NOT NULL), so a maintenance window could not be defined once and
-- suppress alerts/patching/automations/scripts across every org under a
-- partner. This migration makes a window ownable by EITHER an org (org_id
-- set, partner_id NULL — the existing shape) OR a partner (partner_id set,
-- org_id NULL — "partner-wide / all orgs"), enforced by an exactly-one-axis
-- CHECK. Mirrors software_policies (#2126) and automation_policies (#2129).
--
-- maintenance_occurrences has no ownership columns and reaches its tenant
-- through the window join (2026-06-13-b-fk-child-rls-backstop.sql). Those
-- EXISTS policies checked breeze_has_org_access(mw.org_id) only, which is
-- FALSE for a partner-owned parent (org_id NULL) — so they are re-issued
-- here with the dual-axis parent predicate (org OR partner), keeping the
-- same per-command policy names the backstop introduced.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE maintenance_windows
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE maintenance_windows
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'maintenance_windows_one_owner_chk'
      AND conrelid = 'maintenance_windows'::regclass
  ) THEN
    ALTER TABLE maintenance_windows
      ADD CONSTRAINT maintenance_windows_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS maintenance_windows_partner_id_idx
  ON maintenance_windows(partner_id);

-- ============================================
-- Step 2: RLS — maintenance_windows dual-axis (org OR partner)
-- ============================================

ALTER TABLE maintenance_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_windows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON maintenance_windows;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON maintenance_windows;
DROP POLICY IF EXISTS breeze_org_isolation_update ON maintenance_windows;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON maintenance_windows;
DROP POLICY IF EXISTS maintenance_windows_isolation ON maintenance_windows;
CREATE POLICY maintenance_windows_isolation
  ON maintenance_windows
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

-- ============================================
-- Step 3: RLS — maintenance_occurrences window-join gains the partner branch
-- ============================================
-- Same EXISTS shape and policy names as the 2026-06-13-b backstop, with the
-- parent predicate widened to the dual-axis form so occurrences of a
-- partner-owned window stay visible to the owning partner.

ALTER TABLE maintenance_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_occurrences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON maintenance_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON maintenance_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_update ON maintenance_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON maintenance_occurrences;
CREATE POLICY breeze_org_isolation_select ON maintenance_occurrences FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM maintenance_windows mw
    WHERE mw.id = maintenance_occurrences.window_id
      AND (
        (mw.org_id IS NOT NULL AND public.breeze_has_org_access(mw.org_id))
        OR (mw.partner_id IS NOT NULL AND public.breeze_has_partner_access(mw.partner_id))
      )
  )
);
CREATE POLICY breeze_org_isolation_insert ON maintenance_occurrences FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM maintenance_windows mw
    WHERE mw.id = maintenance_occurrences.window_id
      AND (
        (mw.org_id IS NOT NULL AND public.breeze_has_org_access(mw.org_id))
        OR (mw.partner_id IS NOT NULL AND public.breeze_has_partner_access(mw.partner_id))
      )
  )
);
CREATE POLICY breeze_org_isolation_update ON maintenance_occurrences FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM maintenance_windows mw
    WHERE mw.id = maintenance_occurrences.window_id
      AND (
        (mw.org_id IS NOT NULL AND public.breeze_has_org_access(mw.org_id))
        OR (mw.partner_id IS NOT NULL AND public.breeze_has_partner_access(mw.partner_id))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM maintenance_windows mw
    WHERE mw.id = maintenance_occurrences.window_id
      AND (
        (mw.org_id IS NOT NULL AND public.breeze_has_org_access(mw.org_id))
        OR (mw.partner_id IS NOT NULL AND public.breeze_has_partner_access(mw.partner_id))
      )
  )
);
CREATE POLICY breeze_org_isolation_delete ON maintenance_occurrences FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM maintenance_windows mw
    WHERE mw.id = maintenance_occurrences.window_id
      AND (
        (mw.org_id IS NOT NULL AND public.breeze_has_org_access(mw.org_id))
        OR (mw.partner_id IS NOT NULL AND public.breeze_has_partner_access(mw.partner_id))
      )
  )
);
