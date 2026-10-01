-- AI model registry W03 (#7601, PR #7700 review finding 5): the pending
-- settlement replay has a dead-letter.
--
-- replayPendingAiSettlements reads `ORDER BY updated_at ASC LIMIT n` and a
-- failed replay never touched the row, so n permanently failing rows were
-- picked first on every run and starved everything behind them. Now a failed
-- replay bumps updated_at (moves to the back), counts the attempt and keeps
-- the scrubbed error; after MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS it is
-- stamped dead: no longer replayed, no longer merged into the SDK usage
-- snapshot, listed for an operator (listDeadPendingSettlements) and reported
-- to Sentry (ai_settlement_replay_dead).
--
-- New columns on an org-cascade table: registered in CORE_TENANT_EXPORT_POLICY
-- (included). No row writes. Idempotent: ADD COLUMN IF NOT EXISTS, DROP
-- CONSTRAINT IF EXISTS + ADD, CREATE INDEX IF NOT EXISTS. No BEGIN/COMMIT.

ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS pending_settlement_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS pending_settlement_error varchar(128) NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS pending_settlement_dead_at timestamptz NULL;

ALTER TABLE ai_budget_reservations DROP CONSTRAINT IF EXISTS ai_budget_reservations_pending_settlement_attempts_chk;
ALTER TABLE ai_budget_reservations ADD CONSTRAINT ai_budget_reservations_pending_settlement_attempts_chk
  CHECK (pending_settlement_attempts >= 0);

-- The replay's scan: live (not dead) pending settlements, oldest first.
CREATE INDEX IF NOT EXISTS ai_budget_reservations_pending_replay_idx
  ON ai_budget_reservations (updated_at)
  WHERE pending_settlement IS NOT NULL AND pending_settlement_dead_at IS NULL;
-- The operator's dead-letter list, newest first.
CREATE INDEX IF NOT EXISTS ai_budget_reservations_pending_dead_idx
  ON ai_budget_reservations (pending_settlement_dead_at)
  WHERE pending_settlement_dead_at IS NOT NULL;
