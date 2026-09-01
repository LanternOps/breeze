-- P2-5 (#4192) — graduation evidence ledger + graduation state + intent-anchored fix watches.
-- Quorum contract C1/C2/C5. Shape-1 org tenancy throughout (auto-discovered by rls-coverage).

-- ---------------------------------------------------------------- 1. evidence ledger
CREATE TABLE IF NOT EXISTS ai_agent_op_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  namespace text NOT NULL CONSTRAINT ai_agent_op_evidence_namespace_chk
    CHECK (namespace IN ('policy_key','act_op','alert_verdict')),
  op_key text NOT NULL,
  -- Deliberately NO foreign key: a historical copy of the triggering rule, the
  -- same treatment ai_agent_fix_watches.rule_id gets. An ON DELETE SET NULL
  -- here would collapse several rows onto a single NULL key and break the
  -- uniqueness this table exists for.
  rule_id uuid,
  source_kind text NOT NULL CONSTRAINT ai_agent_op_evidence_source_kind_chk
    CHECK (source_kind IN ('intent','watch','act_execution','verdict_feedback')),
  source_id text NOT NULL,
  metric text NOT NULL CONSTRAINT ai_agent_op_evidence_metric_chk
    CHECK (metric IN ('executed','verified','failed','recurred','feedback_up','feedback_down')),
  run_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Composite same-org provenance FK. ai_agent_runs_id_org_uq already exists
-- (renamed by 2026-09-25-ai-agents-ticket-triage.sql) — do not recreate it.
DO $$ BEGIN
  ALTER TABLE ai_agent_op_evidence ADD CONSTRAINT ai_agent_op_evidence_run_org_fk
    FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Exactly-once under BullMQ redelivery: a no-op INSERT means "already counted".
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_op_evidence_source_metric_uq
  ON ai_agent_op_evidence (source_kind, source_id, metric);
-- A re-vote UPDATEs the single feedback row's metric in place; never a negative delta.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_op_evidence_feedback_uq
  ON ai_agent_op_evidence (source_id) WHERE source_kind = 'verdict_feedback';
CREATE INDEX IF NOT EXISTS ai_agent_op_evidence_window_idx
  ON ai_agent_op_evidence (org_id, agent_id, namespace, op_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_op_evidence_prune_idx
  ON ai_agent_op_evidence (occurred_at);

ALTER TABLE ai_agent_op_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_op_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_agent_op_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_agent_op_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_agent_op_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_agent_op_evidence;
CREATE POLICY breeze_org_isolation_select ON ai_agent_op_evidence
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_agent_op_evidence
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_agent_op_evidence
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_agent_op_evidence
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_op_evidence TO breeze_app;

-- ---------------------------------------------------------------- 2. graduation state
CREATE TABLE IF NOT EXISTS ai_agent_graduation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  op_key text NOT NULL,
  state text NOT NULL DEFAULT 'tracking' CONSTRAINT ai_agent_graduation_state_chk
    CHECK (state IN ('tracking','eligible','promoted','demoted')),
  first_verified_at timestamptz,
  promoted_at timestamptz,
  promoted_intent_id uuid,
  demoted_at timestamptz,
  demote_reason text,
  demote_run_id uuid,
  demote_watch_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE ai_agent_graduation ADD CONSTRAINT ai_agent_graduation_intent_org_fk
    FOREIGN KEY (promoted_intent_id, org_id) REFERENCES action_intents (id, org_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_graduation_key_uq
  ON ai_agent_graduation (org_id, agent_id, op_key);
ALTER TABLE ai_agent_graduation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_graduation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_agent_graduation;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_agent_graduation;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_agent_graduation;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_agent_graduation;
CREATE POLICY breeze_org_isolation_select ON ai_agent_graduation
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_agent_graduation
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_agent_graduation
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_agent_graduation
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_graduation TO breeze_app;

-- ---------------------------------------------------- 3. intent-anchored fix watches
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS intent_id uuid;
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'act_run';
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS op_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_source_kind_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_source_kind_chk
  CHECK (source_kind IN ('act_run','intent'));
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_intent_shape_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_intent_shape_chk
  CHECK ((source_kind = 'intent') = (intent_id IS NOT NULL));
DO $$ BEGIN
  ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_intent_org_fk
    FOREIGN KEY (intent_id, org_id) REFERENCES action_intents (id, org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_fix_watches_intent_uq
  ON ai_agent_fix_watches (intent_id) WHERE intent_id IS NOT NULL;
-- The shipped run_id UNIQUE is total; an act run may now also spawn N intent
-- watches, so it becomes partial. DROP the CONSTRAINT (2026-09-18 shipped it
-- as a named constraint, not a bare index) then recreate it as a partial index
-- under the SAME name so nothing that inspects the name by string breaks.
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_run_id_uq;
DROP INDEX IF EXISTS ai_agent_fix_watches_run_id_uq;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_fix_watches_run_id_uq
  ON ai_agent_fix_watches (run_id) WHERE source_kind = 'act_run';
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_pending_recovery_idx
  ON ai_agent_fix_watches (created_at) WHERE state = 'pending';
