-- @no-transaction
-- #4910: keyset traversal index for GET /pam/elevation-audit/export, which
-- pages one org's PAM event ledger in recorded (created_at, id) order. The
-- existing indexes cover (elevation_request_id, occurred_at) and org_id
-- alone, neither of which serves an ordered per-org scan. Built CONCURRENTLY
-- so PAM audit writes are never blocked during the build. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would accept,
-- so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.elevation_audit_org_created_id_idx,
-- then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS elevation_audit_org_created_id_idx
  ON public.elevation_audit (org_id, created_at, id);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.elevation_audit'::regclass
     AND c.relname = 'elevation_audit_org_created_id_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'elevation_audit export index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
