-- apps/api/migrations/2026-09-22-ai-alert-verdicts-live-unique.sql
-- Phase 2 wave P2-1 (alert verdicts), Task 14 carry-in C. Idempotent; no
-- inner BEGIN/COMMIT (autoMigrate wraps the file).
--
-- Adds a partial unique index enforcing at most one LIVE
-- (superseded_by IS NULL) verdict row per alert / per correlation group.
--
-- The self-referencing `superseded_by` FK (auto-generated name
-- `ai_alert_verdicts_superseded_by_fkey`, confirmed via `\d
-- ai_alert_verdicts` against the test DB) is altered DEFERRABLE INITIALLY
-- DEFERRED. This is required by, not incidental to, the unique index above:
-- `persistAlertVerdict` (apps/api/src/services/aiAgents/alertVerdicts.ts)
-- writes a new verdict row and supersedes the prior live one for the same
-- target. Naively inserting the new row THEN superseding the old one (the
-- pre-Task-14 ordering) would violate the new unique index for the instant
-- both rows are live at once — so the write is reordered: the id is
-- generated client-side and the OLD row is superseded FIRST, pointing
-- `superseded_by` at that not-yet-inserted id, and the new row is inserted
-- second. A non-deferrable FK would reject the UPDATE immediately (the
-- referenced id doesn't exist yet); DEFERRABLE INITIALLY DEFERRED checks it
-- once, at COMMIT, by which point the INSERT has run — both statements
-- already execute inside the same transaction (`withSystemDbAccessContext`
-- wraps its callback in `baseDb.transaction(...)`, apps/api/src/db/index.ts).
--
-- A concurrent second writer targeting the same alert/group either has its
-- own UPDATE match zero rows (this transaction's commit already flipped
-- superseded_by away from NULL) and then 23505s on its own INSERT, or wins
-- the race and makes THIS transaction's INSERT the one that 23505s.
-- `persistAlertVerdict` handles either outcome as "superseded concurrently".

ALTER TABLE ai_alert_verdicts
  DROP CONSTRAINT IF EXISTS ai_alert_verdicts_superseded_by_fkey;
ALTER TABLE ai_alert_verdicts
  ADD CONSTRAINT ai_alert_verdicts_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES ai_alert_verdicts(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- Minor 8 (P2-1 wave B task 16d) pre-pass: the two CREATE UNIQUE INDEX
-- statements below fail outright if more than one LIVE (superseded_by IS
-- NULL) row already exists for the same alert_id / correlation_group_id —
-- which the pre-Task-14 code allowed. Supersede all-but-the-newest live row
-- per target FIRST, pointing its superseded_by at the newest (highest
-- created_at, id DESC as a deterministic same-millisecond tiebreak — mirrors
-- the ordering `latestVerdictsForAlerts` already uses at the app layer).
-- Idempotent: after the first run no target has more than one live row left,
-- so a re-run's UPDATEs match zero rows. Per the repo rule on cleanup
-- statements, the row count is reported via RAISE WARNING rather than fixed
-- silently — these rows would otherwise have caused a "different" verdict to
-- read as live depending on query ordering, so the count belongs in the
-- Postgres logs even when it's 0.
DO $$
DECLARE
  n INTEGER;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      FIRST_VALUE(id) OVER (PARTITION BY alert_id ORDER BY created_at DESC, id DESC) AS newest_id,
      ROW_NUMBER() OVER (PARTITION BY alert_id ORDER BY created_at DESC, id DESC) AS rn
    FROM ai_alert_verdicts
    WHERE superseded_by IS NULL AND alert_id IS NOT NULL
  )
  UPDATE ai_alert_verdicts v
  SET superseded_by = ranked.newest_id
  FROM ranked
  WHERE v.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'superseded % duplicate live ai_alert_verdicts row(s) by alert_id before adding ai_alert_verdicts_live_alert_uq', n;
  END IF;
END $$;

DO $$
DECLARE
  n INTEGER;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      FIRST_VALUE(id) OVER (PARTITION BY correlation_group_id ORDER BY created_at DESC, id DESC) AS newest_id,
      ROW_NUMBER() OVER (PARTITION BY correlation_group_id ORDER BY created_at DESC, id DESC) AS rn
    FROM ai_alert_verdicts
    WHERE superseded_by IS NULL AND correlation_group_id IS NOT NULL
  )
  UPDATE ai_alert_verdicts v
  SET superseded_by = ranked.newest_id
  FROM ranked
  WHERE v.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'superseded % duplicate live ai_alert_verdicts row(s) by correlation_group_id before adding ai_alert_verdicts_live_group_uq', n;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_alert_verdicts_live_alert_uq
  ON ai_alert_verdicts (alert_id)
  WHERE superseded_by IS NULL AND alert_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_alert_verdicts_live_group_uq
  ON ai_alert_verdicts (correlation_group_id)
  WHERE superseded_by IS NULL AND correlation_group_id IS NOT NULL;
