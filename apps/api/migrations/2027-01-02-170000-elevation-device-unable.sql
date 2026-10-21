-- #9517: the agent can report an elevation request it is unable to act on.
--
-- When the agent cannot run the PAM flow for a request it has already
-- reported (no SYSTEM helper could be found or started in the requester's
-- Windows session, the session disconnected, ...), the request used to stay
-- 'pending' and a technician could approve something the device would never
-- carry out (#8996 follow-up). The agent now reports that outcome through
-- POST /agents/:id/pam/elevation-unable, which records it here and closes a
-- still-pending request as 'expired'.
--
--   device_unable_at     - when the agent reported it (first report wins)
--   device_unable_reason - a short category code, e.g. 'helper_unavailable',
--                          'session_unavailable', 'helper_start_failed'. Kept
--                          to a code pattern rather than a fixed list so a
--                          newer agent's category needs no migration; the
--                          route validates the categories it knows.
--   device_unable_detail - the agent's own diagnostic message, bounded
--
-- elevation_requests is already RLS-covered by org_id. Nullable columns with
-- no default are metadata-only: no rewrite, no row writes. The CHECK is
-- validated when added, which scans the table once (every existing row has
-- all three columns NULL, so it passes): one sequential scan of every
-- elevation request (UAC, technician JIT, governed AI), whose time depends on
-- the table's size on disk. NOT VALID + VALIDATE would not
-- help here: autoMigrate runs this file in one transaction, so the
-- ACCESS EXCLUSIVE lock from ADD COLUMN is held through VALIDATE anyway.
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS device_unable_at timestamptz;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS device_unable_reason varchar(64);
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS device_unable_detail text;

DO $$ BEGIN
  ALTER TABLE elevation_requests
    ADD CONSTRAINT elevation_requests_device_unable_chk
    CHECK (
      (device_unable_at IS NULL AND device_unable_reason IS NULL AND device_unable_detail IS NULL)
      OR (
        device_unable_at IS NOT NULL
        AND device_unable_reason IS NOT NULL
        AND device_unable_reason ~ '^[a-z][a-z_]{0,63}$'
        AND (device_unable_detail IS NULL OR char_length(device_unable_detail) <= 1000)
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;

-- Audit event for the report. ALTER TYPE ... ADD VALUE inside autoMigrate's
-- per-file transaction is fine on Postgres 12+ because this file never uses
-- the new value (same note as 2026-05-27-a-elevation-status-add-actuating.sql).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'elevation_audit_event_type') THEN
    ALTER TYPE elevation_audit_event_type ADD VALUE IF NOT EXISTS 'device_unable';
  END IF;
END $$;
