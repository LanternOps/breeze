-- @no-transaction
-- Partial indexes for GET /remote/devices/:deviceId/active-sessions, which reads
-- one device's live sessions on every device-page poll.
--
-- 1. remote_sessions (device_id) WHERE status IN ('pending','connecting','active')
--    remote_sessions has no device_id index, so the read was a scan. Only live
--    rows are indexed, which keeps it small: ended sessions make up almost all
--    of the table.
--
-- 2. tunnel_sessions (device_id) WHERE type = 'vnc' AND status IN (...)
--    The VNC half of the same read. The only existing index on device_id is
--    tunnel_sessions_device_idx, and under FORCE RLS the per-row policy then
--    runs on every tunnel row the device has ever had (nothing prunes
--    tunnel_sessions). Only live VNC rows are indexed.
--
-- Both predicates are inline literals that must match remoteSessionIsLive()
-- (db/schema/remote.ts) and tunnelSessionIsLiveVnc() (db/schema/tunnels.ts),
-- so the planner can use these indexes under generic plans.
--
-- CREATE INDEX CONCURRENTLY: both tables take writes whenever a session starts
-- or ends. IF NOT EXISTS keeps re-application a no-op. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would silently
-- accept, so the DO block fails loudly. Recovery: DROP INDEX CONCURRENTLY
-- <name>, then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS remote_sessions_device_live_idx
  ON public.remote_sessions (device_id)
  WHERE status IN ('pending', 'connecting', 'active');

CREATE INDEX CONCURRENTLY IF NOT EXISTS tunnel_sessions_device_live_vnc_idx
  ON public.tunnel_sessions (device_id)
  WHERE type = 'vnc' AND status IN ('pending', 'connecting', 'active');

DO $$
DECLARE
  bad text;
BEGIN
  -- Pair each index with its table so an unrelated same-named INVALID index
  -- elsewhere cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.remote_sessions'::regclass, 'remote_sessions_device_live_idx'),
      ('public.tunnel_sessions'::regclass, 'tunnel_sessions_device_live_vnc_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'live-session index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
