-- Add 'actuating' to elevation_status enum so the PAM Track 5 actuator route
-- (POST /devices/:id/actuate-elevation) can transactionally CAS the row from
-- 'approved' → 'actuating' as a single-use guard. Without this, an approved
-- elevation_requests row can be POSTed to /actuate-elevation N times, each
-- queueing a fresh actuate_elevation device_command with the cleartext
-- credential — a credential-replay / multi-spawn vector.
--
-- PR #960 review (Todd, 2026-05-27 14:56Z, CHANGES_REQUESTED):
--   "wrap the SELECT + UPDATE-to-'actuating' + command insert in a single
--   transaction with WHERE status='approved' and refuse if zero rows updated"
--
-- The actuator route's transaction does:
--   SELECT ... FOR UPDATE
--   UPDATE elevation_requests SET status='actuating'
--     WHERE id=$1 AND status='approved' RETURNING id
--   INSERT INTO device_commands ...
--   INSERT INTO elevation_audit ...
--
-- After actuation the row remains in 'actuating' until the agent reports
-- completion (Track 6 — JIT credential expiry + cleanup). At that point it
-- flips to either 'expired' (TTL hit) or 'revoked' (cancelled mid-flight).
--
-- Postgres note: ALTER TYPE ... ADD VALUE inside an outer transaction works
-- in Postgres 12+ as long as the new value isn't *used* in the same
-- transaction. autoMigrate wraps each file in client.begin(); we never use
-- 'actuating' in this migration, so no rewrite occurs.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'elevation_status') THEN
    ALTER TYPE elevation_status ADD VALUE IF NOT EXISTS 'actuating';
  END IF;
END $$;
