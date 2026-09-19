-- 2026-09-28: one-attempt marker for automatic agent edition migration (#4072).
--
-- When the heartbeat's artifact-edition gate withholds an update offer from a
-- stranded self-host-build Windows agent, the server can (behind the
-- AGENT_EDITION_AUTO_MIGRATE_ENABLED flag) dispatch the 'Migrate Agent Edition
-- (Windows)' system script automatically. This column is the atomic
-- once-per-device claim: the dispatcher only fires on
-- edition_migration_dispatched_at IS NULL and stamps it in the same UPDATE, so
-- two concurrent heartbeats cannot both dispatch and a failed dance is never
-- auto-retried into an uninstall loop.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; re-applying is a no-op.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS edition_migration_dispatched_at timestamptz;
