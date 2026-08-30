-- W06 (#3900): time-entry provenance + auto-suggestion decisions ledger.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).
--
-- Filename note: the plan (spec D8) named 2026-09-23-…, but by the time this
-- landed origin/main already shipped 2026-09-23-ai-agents-scheduled-sweeps.sql
-- and 2026-09-24-{a,b}-…, so a 2026-09-23 prefix would have wedged this file
-- INTO a shipped date block and replayed in a different order on a fresh
-- database than on a migrated one. Dated forward instead, exactly as D8
-- instructs ("if a later migration lands before this ships, bump the date").

-- 1) time_entries provenance. Column is shared with the location-suggestions
--    spec (2026-08-28 §2.2); W06 owns its creation. Server-stamped only.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS source varchar(24) NOT NULL DEFAULT 'manual';
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_chk;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_chk
  CHECK (source IN ('manual','timer','location','remote_session','support_session'));

-- 2) Signal read index: one user's ended sessions inside a day window.
--    Plain CREATE INDEX (CONCURRENTLY is impossible inside the migration
--    transaction) — brief lock on very large self-hosted remote_sessions.
CREATE INDEX IF NOT EXISTS remote_sessions_user_ended_idx
  ON remote_sessions (user_id, ended_at) WHERE ended_at IS NOT NULL;

-- 3) Decisions ledger — RLS Shape 3 (partner-axis). Deliberately NO org_id and
--    NO device_id, so it is registered in PARTNER_TENANT_TABLES only.
--    signal_id has no FK: signal/device rows may be purged; orphan decisions are
--    inert and leave with the user (CASCADE) or the partner (sweep + CASCADE).
CREATE TABLE IF NOT EXISTS time_suggestion_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_kind    varchar(24) NOT NULL,
  signal_id      uuid NOT NULL,
  decision       varchar(16) NOT NULL,
  time_entry_id  uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_suggestion_decisions_kind_chk     CHECK (signal_kind IN ('remote_session')),
  CONSTRAINT time_suggestion_decisions_decision_chk CHECK (decision IN ('confirmed','dismissed')),
  CONSTRAINT time_suggestion_decisions_entry_chk    CHECK (decision = 'confirmed' OR time_entry_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_suggestion_decisions_user_signal_uq
  ON time_suggestion_decisions (user_id, signal_kind, signal_id);
CREATE INDEX IF NOT EXISTS time_suggestion_decisions_partner_idx
  ON time_suggestion_decisions (partner_id);
CREATE INDEX IF NOT EXISTS time_suggestion_decisions_entry_idx
  ON time_suggestion_decisions (time_entry_id) WHERE time_entry_id IS NOT NULL;

ALTER TABLE time_suggestion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_suggestion_decisions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'time_suggestion_decisions'
      AND policyname = 'time_suggestion_decisions_partner_access'
  ) THEN
    CREATE POLICY time_suggestion_decisions_partner_access ON time_suggestion_decisions
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- ensureAppRole sets ALTER DEFAULT PRIVILEGES for breeze_app, so this is
-- belt-and-braces for databases created before that default was in place.
GRANT SELECT, INSERT, UPDATE, DELETE ON time_suggestion_decisions TO breeze_app;
