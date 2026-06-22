-- Make patch_approvals partner-scoped. A ring-specific row (ring_id set) approves
-- that ring everywhere; a ring_id IS NULL row is a partner-wide blanket approval.
-- Idempotent + forward-only.

-- 1. Add partner_id (nullable first).
ALTER TABLE patch_approvals ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- 2. Backfill partner_id from each approval's org.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE patch_approvals a
     SET partner_id = o.partner_id
    FROM organizations o
   WHERE a.org_id = o.id
     AND a.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'patch_approvals partner backfill: % rows', n; END IF;
END $$;

-- 3. Dedup collisions BEFORE the new unique index. Two orgs under one partner can
-- both hold a (patch, ring) approval that now collapses onto the same partner key.
-- Keep one deterministic winner per (partner_id, patch_id, COALESCE(ring_id,NIL)):
-- status precedence approved>deferred>rejected>pending, then latest updated_at,
-- then latest id. Delete the losers and report the count (forensic trail).
DO $$
DECLARE n bigint;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY partner_id, patch_id, COALESCE(ring_id, '00000000-0000-0000-0000-000000000000')
             ORDER BY CASE status
                        WHEN 'approved' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'rejected' THEN 2
                        ELSE 3
                      END,
                      updated_at DESC,
                      id DESC
           ) AS rn
      FROM patch_approvals
  )
  DELETE FROM patch_approvals WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'patch_approvals dedup on partner-scope: % duplicate rows removed', n; END IF;
END $$;

-- 4. Swap the unique index org->partner.
DROP INDEX IF EXISTS patch_approvals_org_patch_ring_unique;
CREATE UNIQUE INDEX IF NOT EXISTS patch_approvals_partner_patch_ring_unique
  ON patch_approvals (partner_id, patch_id, COALESCE(ring_id, '00000000-0000-0000-0000-000000000000'));

-- 5. Drop old org-axis RLS policies.
DROP POLICY IF EXISTS breeze_org_isolation_select ON patch_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON patch_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_update ON patch_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON patch_approvals;

-- 6. Enforce NOT NULL, drop org_id.
ALTER TABLE patch_approvals ALTER COLUMN partner_id SET NOT NULL;
ALTER TABLE patch_approvals DROP COLUMN IF EXISTS org_id;

-- 7. Partner-axis RLS.
ALTER TABLE patch_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON patch_approvals;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON patch_approvals;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON patch_approvals;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON patch_approvals;
CREATE POLICY breeze_partner_isolation_select ON patch_approvals
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON patch_approvals
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON patch_approvals
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON patch_approvals
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

CREATE INDEX IF NOT EXISTS patch_approvals_partner_id_idx ON patch_approvals (partner_id);
