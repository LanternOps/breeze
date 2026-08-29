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

CREATE UNIQUE INDEX IF NOT EXISTS ai_alert_verdicts_live_alert_uq
  ON ai_alert_verdicts (alert_id)
  WHERE superseded_by IS NULL AND alert_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_alert_verdicts_live_group_uq
  ON ai_alert_verdicts (correlation_group_id)
  WHERE superseded_by IS NULL AND correlation_group_id IS NOT NULL;
