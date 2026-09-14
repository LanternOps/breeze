-- #4177 (W04): AI-proposed time entries.
--
-- Elect system scope before the CHECK re-add: time_entries is FORCE ROW LEVEL
-- SECURITY and the validating ADD CONSTRAINT scans existing rows, which under
-- 'none' scope would see nothing and validate vacuously.
SELECT set_config('breeze.scope', 'system', true);

-- 1. Widen the source vocabulary. Drop-then-add because a CHECK cannot be
--    altered in place; both halves are guarded so re-application is a no-op.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_chk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_source_chk
  CHECK (source IN ('manual', 'timer', 'location', 'remote_session', 'support_session', 'ai_suggested'));

-- 2. The duration default an AI proposal pre-fills from. Nullable on purpose:
--    a partner who has not set one gets the module constant fallback
--    (AI_TIME_ENTRY_DEFAULT_MINUTES) rather than a guessed number baked into
--    every category row. ticket_categories is partner-keyed (no org_id), so
--    this column triggers no export-policy or org-cascade registration —
--    verified by grep against tenantCascade.ts / tenantExportPolicyRegistry.ts.
ALTER TABLE ticket_categories
  ADD COLUMN IF NOT EXISTS default_time_entry_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_default_time_entry_minutes_chk'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_default_time_entry_minutes_chk
      CHECK (default_time_entry_minutes IS NULL OR (default_time_entry_minutes > 0 AND default_time_entry_minutes <= 1440));
  END IF;
END $$;
