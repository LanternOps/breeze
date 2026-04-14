-- 2026-04-13: Rewrite devices.hostname rows that were populated with
-- the device's own UUID (or agent token) instead of a real hostname.
--
-- Context: issue #439 — at least one prod device shipped with
-- devices.hostname = '<uuid>' (matching the same row's id). The fix
-- for future enrollments lives in the Go agent (fallback chain in
-- agent/internal/collectors/hostname.go + refuse-to-enroll guard in
-- cmd/breeze-agent/main.go). This migration cleans up the rows the
-- old behavior left behind.
--
-- Strategy: any row where hostname exactly equals either the device's
-- own id::text OR its agent_id gets renamed to a loud placeholder
-- ("UNKNOWN-HOST-<first 8 chars of id>") that is:
--   - unique per device (so we don't create constraint violations via
--     the unique index on (org_id, site_id, hostname) — if any org/site
--     has > 1 bad row, each gets a distinct placeholder)
--   - obviously-fake to operators reading the UI
--   - deterministic, so re-running the migration is a no-op
--
-- Idempotency: after the first run the WHERE clause no longer matches
-- (hostname has been rewritten), so running this migration twice is
-- safe. No IF EXISTS guards needed — devices table is part of the
-- baseline schema.

UPDATE devices
SET hostname   = 'UNKNOWN-HOST-' || SUBSTRING(id::text, 1, 8),
    updated_at = NOW()
WHERE hostname = id::text
   OR hostname = agent_id;
