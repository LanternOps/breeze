-- #8971: 'withdrawn' — the end user declined a pending elevation on the device.
--
-- When the person at the keyboard answers Deny, lets the PAM dialog time out,
-- or the dialog errors, the agent tells the server through
-- POST /api/v1/agents/:id/elevation-requests/:requestId/withdraw, which moves
-- the request pending -> withdrawn (with withdrawn_at / withdrawn_reason, added
-- by the next migration) so no technician can approve it afterwards.
--
-- This file only adds the enum values; it never uses them. autoMigrate wraps
-- each file in its own transaction, and Postgres forbids using an enum value
-- in the transaction that added it, so the CHECK that names 'withdrawn' lives
-- in 2027-01-10-100100-pam-elevation-withdrawn-columns.sql, which sorts after
-- this one. Same guard as 2026-05-27-a-elevation-status-add-actuating.sql.
-- No rows are written, so no breeze.scope election is needed.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'elevation_status') THEN
    ALTER TYPE elevation_status ADD VALUE IF NOT EXISTS 'withdrawn';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'elevation_audit_event_type') THEN
    ALTER TYPE elevation_audit_event_type ADD VALUE IF NOT EXISTS 'withdrawn';
  END IF;
END $$;
