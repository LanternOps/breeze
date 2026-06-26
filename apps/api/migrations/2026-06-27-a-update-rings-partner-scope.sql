-- Make update rings (patch_policies) partner-scoped instead of org-scoped.
-- Rings reach orgs only via configuration-policy assignment, so the org binding
-- is dropped in favour of partner ownership. Idempotent + forward-only.

-- 1. Add partner_id (nullable first for backfill).
ALTER TABLE patch_policies ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- 2. Backfill partner_id from each ring's org.
DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'patch_policies'
       AND column_name = 'org_id'
  ) THEN
    UPDATE patch_policies p
       SET partner_id = o.partner_id
      FROM organizations o
     WHERE p.org_id = o.id
       AND p.partner_id IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'patch_policies partner backfill: % rows', n; END IF;
  END IF;
END $$;

-- 3. Enforce NOT NULL once backfilled.
ALTER TABLE patch_policies ALTER COLUMN partner_id SET NOT NULL;

-- 4. Drop the old org-axis RLS policies.
DROP POLICY IF EXISTS breeze_org_isolation_select ON patch_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON patch_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON patch_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON patch_policies;

-- 5. Drop org_id (FK + column).
ALTER TABLE patch_policies DROP COLUMN IF EXISTS org_id;

-- 6. Partner-axis RLS.
ALTER TABLE patch_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON patch_policies;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON patch_policies;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON patch_policies;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON patch_policies;
CREATE POLICY breeze_partner_isolation_select ON patch_policies
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON patch_policies
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON patch_policies
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON patch_policies
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 7. Index for partner-filtered list queries.
CREATE INDEX IF NOT EXISTS patch_policies_partner_id_idx ON patch_policies (partner_id);
