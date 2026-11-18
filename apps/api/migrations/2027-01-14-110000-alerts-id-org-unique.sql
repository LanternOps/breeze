-- @no-transaction
-- Target of alert_external_refs_alert_org_fk. alerts is hot, so build the
-- composite unique index CONCURRENTLY without blocking writes. DDL only.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS alerts_id_org_uq ON public.alerts (id, org_id);

-- An interrupted CONCURRENTLY build leaves an INVALID index that
-- IF NOT EXISTS would silently accept, so fail loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.<invalid_index_name>, then
-- let autoMigrate re-run this file.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.alerts'::regclass
     AND c.relname = 'alerts_id_org_uq'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'alerts id/org index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
