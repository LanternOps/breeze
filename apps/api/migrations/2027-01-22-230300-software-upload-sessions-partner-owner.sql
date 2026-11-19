-- #11412 W01 (origin #9246): chunked upload sessions can be partner-owned.
--
-- A session now mirrors the ownership of the software_catalog row it uploads
-- into: an org-owned package books an org session (org_id set, as before); a
-- partner-wide package (org_id NULL, partner_id set — e.g. the built-in
-- SentinelOne package) books a partner session. Booking a partner upload under
-- a nominal child org would leak it into that customer's quota, export and
-- erasure, so the session carries the partner itself. The route layer
-- enforces the mirroring (create copies the owner from the catalog row,
-- /complete re-reads the catalog under the session's owner); the schema only
-- enforces org XOR partner — no composite FK for a row that lives <= 24 h.
--
-- Tenancy: dual-axis org XOR partner (software_upload_sessions_one_owner_chk),
-- RLS enabled AND forced. Deliberately NO partner-wide SELECT branch: an
-- org-scope token must never read a partner's upload session (the
-- reports/webhooks precedent — DUAL_AXIS_TENANT_TABLES, absent from
-- XOR_OWNERSHIP_DUAL_AXIS_TABLES in rls-coverage.integration.test.ts).
--
-- Registries: the org cascade entry deletes WHERE org_id = … and never touches
-- partner rows; the org-merge repoint rewrites org_id only; the partner cascade
-- discovers partner_id tables from information_schema; partner_id is
-- classified `included` in the tenant export policy.
--
-- partner_id -> partners ON DELETE CASCADE, matching org_id -> organizations:
-- a session lives at most 24 h and must never block a parent delete.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, CREATE INDEX IF NOT
-- EXISTS, DROP POLICY IF EXISTS before each CREATE POLICY. Writes no rows.

ALTER TABLE software_upload_sessions
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE software_upload_sessions ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_upload_sessions_one_owner_chk'
      AND conrelid = 'software_upload_sessions'::regclass
  ) THEN
    ALTER TABLE software_upload_sessions
      ADD CONSTRAINT software_upload_sessions_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_upload_sessions_partner_id_idx
  ON software_upload_sessions(partner_id);

ALTER TABLE software_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_upload_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_upload_sessions;

DROP POLICY IF EXISTS software_upload_sessions_dual_isolation_select ON software_upload_sessions;
DROP POLICY IF EXISTS software_upload_sessions_dual_isolation_insert ON software_upload_sessions;
DROP POLICY IF EXISTS software_upload_sessions_dual_isolation_update ON software_upload_sessions;
DROP POLICY IF EXISTS software_upload_sessions_dual_isolation_delete ON software_upload_sessions;

CREATE POLICY software_upload_sessions_dual_isolation_select ON software_upload_sessions
  FOR SELECT USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_upload_sessions_dual_isolation_insert ON software_upload_sessions
  FOR INSERT WITH CHECK (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_upload_sessions_dual_isolation_update ON software_upload_sessions
  FOR UPDATE USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_upload_sessions_dual_isolation_delete ON software_upload_sessions
  FOR DELETE USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON software_upload_sessions TO breeze_app;
