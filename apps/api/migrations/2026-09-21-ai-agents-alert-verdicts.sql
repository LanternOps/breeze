-- apps/api/migrations/2026-09-21-ai-agents-alert-verdicts.sql
-- Phase 2 wave P2-1 (alert verdicts). Spec:
-- docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md §4.1, §5.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'full';
DO $$ BEGIN
  ALTER TABLE ai_agent_runs
    ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full', 'verdict'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS correlation_group_id uuid
    REFERENCES alert_correlation_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_correlation_group_idx
  ON ai_agent_runs (correlation_group_id) WHERE correlation_group_id IS NOT NULL;
-- Verdict admission counts only verdict-profile rows (runService step 6b).
CREATE INDEX IF NOT EXISTS ai_agent_runs_agent_profile_queued_idx
  ON ai_agent_runs (agent_id, org_id, profile, queued_at DESC);

CREATE TABLE IF NOT EXISTS ai_alert_verdicts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id               uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  alert_id             uuid REFERENCES alerts(id) ON DELETE CASCADE,
  correlation_group_id uuid REFERENCES alert_correlation_groups(id) ON DELETE CASCADE,
  classification       text NOT NULL,
  confidence           numeric(3,2) NOT NULL,
  rationale            text NOT NULL,
  pattern              jsonb,
  suggested_intent_id  uuid REFERENCES action_intents(id) ON DELETE SET NULL,
  feedback             text,
  feedback_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  feedback_at          timestamptz,
  superseded_by        uuid REFERENCES ai_alert_verdicts(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_alert_verdicts_target_chk
    CHECK ((alert_id IS NULL) <> (correlation_group_id IS NULL)),
  CONSTRAINT ai_alert_verdicts_classification_chk CHECK (classification IN
    ('actionable', 'transient_self_healed', 'recurring_pattern', 'duplicate_of_group', 'needs_human')),
  CONSTRAINT ai_alert_verdicts_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT ai_alert_verdicts_feedback_chk CHECK (feedback IS NULL OR feedback IN ('up', 'down'))
);
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_alert_idx
  ON ai_alert_verdicts (org_id, alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_group_idx
  ON ai_alert_verdicts (org_id, correlation_group_id) WHERE correlation_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_latest_idx
  ON ai_alert_verdicts (org_id, created_at DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_run_idx ON ai_alert_verdicts (run_id);

ALTER TABLE ai_alert_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_alert_verdicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_alert_verdicts_isolation ON ai_alert_verdicts;
CREATE POLICY ai_alert_verdicts_isolation ON ai_alert_verdicts
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_alert_verdicts TO breeze_app;
