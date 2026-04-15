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
-- RLS note: devices is FORCE ROW LEVEL SECURITY with policies gated on
-- breeze_has_org_access(org_id), and breeze_current_scope() defaults to
-- 'none' unless GUCs are set (see 0012-tenant-rls-deny-default.sql).
-- autoMigrate.ts runs each migration via raw tx.unsafe(...) and does
-- not establish a scope, so on managed Postgres installs where the
-- migration admin role is non-superuser (DigitalOcean, RDS, etc. — see
-- apps/api/src/db/ensureAppRole.ts) this UPDATE would be filtered to
-- zero rows by RLS and still be recorded as applied. We explicitly
-- set system scope for the duration of this transaction.
--
-- Placeholder strategy: each affected row is rewritten to a per-device
-- placeholder ("UNKNOWN-HOST-<first 8 chars of id>") that is:
--   - per-device (so operators don't see dozens of identical rows,
--     and any future hostname-uniqueness constraint would not collide)
--   - obviously-fake to operators reading the UI
--   - deterministic, so re-running the migration is a no-op
--
-- Idempotency: after the first run the WHERE clause no longer matches
-- (hostname has been rewritten), so re-running is safe. No IF EXISTS
-- guards needed — devices is part of the baseline schema.

SELECT set_config('breeze.scope', 'system', true);

UPDATE devices
SET hostname   = 'UNKNOWN-HOST-' || SUBSTRING(id::text, 1, 8),
    updated_at = NOW()
WHERE hostname = id::text
   OR hostname = agent_id;
