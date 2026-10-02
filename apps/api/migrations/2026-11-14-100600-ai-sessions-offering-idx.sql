-- @no-transaction
-- AI model registry W02 (#7600): index for the ai_sessions offering FK
-- (ON DELETE SET NULL scans by offering_id) and W03's session-binding reads.
-- Built CONCURRENTLY so chat writes are never blocked. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would accept,
-- so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.ai_sessions_offering_idx, then let
-- autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_sessions_offering_idx
  ON public.ai_sessions (offering_id) WHERE offering_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.ai_sessions'::regclass
     AND c.relname = 'ai_sessions_offering_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ai_sessions offering index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
