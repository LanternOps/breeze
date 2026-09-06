-- Phase 2 wave P2-6 (#4187 / #4193): AI agent value accounting.
--   1. ai_agent_impact_daily (Shape 1, forced RLS): ten per-(org, UTC-day)
--      counters + llm_cents, rebuilt idempotently by aiAgentImpactRollup.
--      est_seconds_saved is deliberately NOT a column — it is computed at read
--      time from these counters and the partner's effective weights, so
--      re-pricing a weight re-prices history instead of forking it.
--   2. partners.ai_impact_weights: PARTIAL overrides onto the frozen defaults
--      in @breeze/shared (DEFAULT_IMPACT_WEIGHTS); NULL means "defaults".
--      A dedicated column rather than a partners.settings sub-object, per the
--      schema's own preference note (db/schema/orgs.ts:38-41) — settings cards
--      replace sub-objects wholesale and would silently drop the weights.
--   3. Source indexes for the eight bounded scans the rollup performs.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. ai_agent_impact_daily --------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_impact_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- UTC calendar day. Every writer buckets with
  -- `(<source timestamp> AT TIME ZONE 'UTC')::date`; never date_trunc, which
  -- follows the session timezone a self-hoster can change.
  day date NOT NULL,
  alerts_judged        integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_alerts_judged_chk        CHECK (alerts_judged >= 0),
  noise_flagged        integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_noise_flagged_chk        CHECK (noise_flagged >= 0),
  suppressions_applied integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_suppressions_chk         CHECK (suppressions_applied >= 0),
  tickets_triaged      integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_tickets_triaged_chk      CHECK (tickets_triaged >= 0),
  drafts_sent          integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_drafts_sent_chk          CHECK (drafts_sent >= 0),
  fixes_proposed       integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_fixes_proposed_chk       CHECK (fixes_proposed >= 0),
  fixes_executed       integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_fixes_executed_chk       CHECK (fixes_executed >= 0),
  fix_watches_held     integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_watches_held_chk         CHECK (fix_watches_held >= 0),
  fix_watches_recurred integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_watches_recurred_chk     CHECK (fix_watches_recurred >= 0),
  narratives_delivered integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_narratives_chk           CHECK (narratives_delivered >= 0),
  llm_cents            integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_llm_cents_chk            CHECK (llm_cents >= 0),
  rebuilt_at timestamptz NOT NULL DEFAULT now()
);

-- ON CONFLICT (org_id, day) target for the rollup's single UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_impact_daily_org_day_uq
  ON ai_agent_impact_daily (org_id, day);
-- Partner-window scan: a 90-day partner read filters on `day` FIRST and then
-- intersects with the caller's accessible org list. Leading with org_id (the
-- unique above) makes that an N-org index scan; leading with day makes it one
-- range. Both are kept — verify with EXPLAIN (ANALYZE, BUFFERS) on a seeded DB.
CREATE INDEX IF NOT EXISTS ai_agent_impact_daily_day_org_idx
  ON ai_agent_impact_daily (day, org_id);

ALTER TABLE ai_agent_impact_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_impact_daily FORCE ROW LEVEL SECURITY;

-- RLS: direct NOT NULL org_id (Shape 1) — the canonical single-clause idiom.
-- breeze_has_org_access() already returns TRUE for system scope internally
-- (public.breeze_has_org_access, 0001-baseline.sql), so no separate system
-- branch is needed. Same shape as ticket_drafts
-- (2026-09-25-ai-agents-ticket-triage.sql) and action_intents.
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_agent_impact_daily;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_agent_impact_daily;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_agent_impact_daily;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_agent_impact_daily;

CREATE POLICY breeze_org_isolation_select ON ai_agent_impact_daily
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_agent_impact_daily
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_agent_impact_daily
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_agent_impact_daily
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_impact_daily TO breeze_app;

-- 2. partners.ai_impact_weights ---------------------------------------------
ALTER TABLE partners ADD COLUMN IF NOT EXISTS ai_impact_weights jsonb;
COMMENT ON COLUMN partners.ai_impact_weights IS
  'P2-6 (#4193). PARTIAL overrides of DEFAULT_IMPACT_WEIGHTS (@breeze/shared); NULL = defaults. Six keys, each an integer 0..86400 seconds. Never read directly — always through resolveImpactWeights().';

-- 3. Source indexes ---------------------------------------------------------
-- Every one of these bounds a rollup scan to (org, time-range). Each was
-- checked against the live schema first: ai_agent_runs already has
-- ai_agent_runs_org_queued_idx (org_id, queued_at DESC), which serves the
-- llm_cents pass, so no queued_at index is added here.

-- runs: serves tickets_triaged (profile='triage'), narratives_delivered
-- (profile='narrative') AND the two jsonb lateral arms (profile='full'). One
-- (org_id, profile, finished_at) index covers all four; a profile='full'-only
-- partial would leave triage and narrative unindexed.
CREATE INDEX IF NOT EXISTS ai_agent_runs_org_profile_finished_idx
  ON ai_agent_runs (org_id, profile, finished_at)
  WHERE finished_at IS NOT NULL;

-- verdicts: ai_alert_verdicts_latest_idx is PARTIAL on superseded_by IS NULL,
-- so it cannot serve the "every persisted verdict" count.
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_created_idx
  ON ai_alert_verdicts (org_id, created_at);
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_feedback_idx
  ON ai_alert_verdicts (org_id, feedback_at)
  WHERE feedback_at IS NOT NULL;

-- intents: action_intents_org_status_idx is (org_id, status, expires_at) —
-- neither created_at nor executed_at is covered.
CREATE INDEX IF NOT EXISTS action_intents_org_created_idx
  ON action_intents (org_id, created_at);
CREATE INDEX IF NOT EXISTS action_intents_org_executed_idx
  ON action_intents (org_id, executed_at)
  WHERE executed_at IS NOT NULL;

-- fix watches: existing indexes are (org_id, created_at DESC) and (state, due_at).
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_org_evaluated_idx
  ON ai_agent_fix_watches (org_id, evaluated_at)
  WHERE evaluated_at IS NOT NULL;

-- ticket drafts: existing indexes are (org_id), (ticket_id) and the active
-- partial unique.
CREATE INDEX IF NOT EXISTS ticket_drafts_org_consumed_idx
  ON ticket_drafts (org_id, consumed_at)
  WHERE consumed_at IS NOT NULL;
