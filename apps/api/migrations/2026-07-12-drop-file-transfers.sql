-- Drop the dead chunked file-transfer subsystem's table (#2396, option 2).
--
-- The `file_transfers` table backed the never-functional /remote/transfers*
-- chunked-transfer path: no server code ever dispatched `file_transfer` /
-- `cancel_transfer` commands to the agent, and nothing has called
-- POST /remote/transfers since the web FileManager moved to the system-tools
-- single-shot file_read/file_write path (9379f1792, Feb 2026) — and even
-- before that, the create route only inserted DB rows. Any rows present are
-- inert metadata from that never-fired feature.
--
-- Forensic trail: log the row count before dropping (repo rule — destructive
-- cleanup must record what it destroyed, even when the count is 0).
DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.file_transfers') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.file_transfers' INTO n;
    RAISE WARNING 'dropping file_transfers with % rows (dead chunked-transfer path, #2396)', n;
  END IF;
END $$;

DROP TABLE IF EXISTS file_transfers;

-- Enum types used only by file_transfers columns.
DROP TYPE IF EXISTS file_transfer_direction;
DROP TYPE IF EXISTS file_transfer_status;
