-- Wave 6 PR 2 (#3828): schema foundations for the two safety mechanisms the
-- wave-6 quorum locked (2026-08-28) — see the plan header
-- (docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-2-safety-controls.md)
-- for the full design authority.
--
-- 1. ai_agent_fix_watches: after an act-lane remediation verifies, watch
--    whether the triggering alert recovers, and if it does, whether it
--    recurs within FIX_HOLD_MINUTES. Recurrence pages the operators.
--    RLS Shape 1 (direct org_id + denormalized partner_id, composite FK to
--    organizations for dual-axis integrity) — same shape as
--    llm_egress_events / ai_unattended_exposure, followed verbatim for the
--    RLS policy. `device_id` carries NO FK, same exposure precedent as
--    ai_unattended_exposure.device_id: device rows are deleted/moved
--    independently of watch history. `rule_id` is a plain denormalized copy
--    of the triggering alert's rule_id (no FK) so a watch can still
--    classify a recurrence after the alert row itself is gone.
--
-- 2. ai_agent_circuit_state: per-(org_id, agent_id) failure-streak
--    accounting. Repeated agent failures in an org auto-open a circuit that
--    skips new admissions until a human resets it with MFA. PRIMARY KEY is
--    the (org_id, agent_id) tuple itself — this is per-org, per-agent
--    STATE, never ai_agents.enabled (a partner-level column). Same RLS
--    Shape 1 as above. `last_run_id` and `reset_by` carry NO FK — both are
--    informational pointers (the run that last transitioned the circuit,
--    the admin who last reset it), not live references this row's
--    lifecycle depends on, same reasoning as ai_kill_state.updated_by.
--
-- Cascade-order note (Global Constraints, same as ai_unattended_exposure):
-- both tables sort alphabetically BEFORE 'ai_agent_runs'/'ai_agents' in
-- CORE_ORG_CASCADE_DELETE_ORDER even though ai_agent_fix_watches
-- FK-references both — position-independent because every FK on both
-- tables below carries an EXPLICIT ON DELETE, so tenantCascade's runtime
-- pg_constraint read (topologicalCascadeOrder) is what actually orders the
-- DELETE, not the hand list's alphabetization.
--
-- Idempotent throughout: CREATE TABLE IF NOT EXISTS, DO-guarded CHECK/
-- policy adds. No inner BEGIN/COMMIT (autoMigrate wraps the whole file in
-- one transaction).

-- ---------------------------------------------------------------------------
-- 1. ai_agent_fix_watches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_fix_watches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  partner_id          uuid NOT NULL,
  agent_id            uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  run_id              uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  alert_id            uuid REFERENCES alerts(id) ON DELETE SET NULL,
  -- Denormalized from the triggering alert's rule_id. No FK: must survive
  -- the alert row (and even the rule row) being deleted, so recurrence
  -- classification can still run against the copied value.
  rule_id             uuid,
  -- No FK: device rows are deleted/moved independently of watch history —
  -- same exposure precedent as ai_unattended_exposure.device_id.
  device_id           uuid NOT NULL,
  config_item_name    varchar(200),
  state               text NOT NULL DEFAULT 'pending',
  recovery_observed_at timestamptz,
  due_at              timestamptz,
  evaluated_at        timestamptz,
  recurrence_alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL,
  notified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_fix_watches_run_id_uq UNIQUE (run_id),
  CONSTRAINT ai_agent_fix_watches_state_chk
    CHECK (state IN ('pending', 'watching', 'recurred', 'held_qualified', 'inconclusive', 'cancelled')),
  -- Dual-axis integrity, the llm_egress_events / ai_unattended_exposure
  -- pattern: a row cannot name an org that belongs to a different partner
  -- than the one it bills.
  CONSTRAINT ai_agent_fix_watches_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_org_created_idx
  ON ai_agent_fix_watches(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_state_due_idx
  ON ai_agent_fix_watches(state, due_at);

-- RLS shape 1 (direct org_id column) — verbatim template, llm_egress_events.
ALTER TABLE ai_agent_fix_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_fix_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_fix_watches_isolation ON ai_agent_fix_watches;
CREATE POLICY ai_agent_fix_watches_isolation ON ai_agent_fix_watches
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_fix_watches TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. ai_agent_circuit_state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_circuit_state (
  org_id               uuid NOT NULL,
  agent_id             uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  partner_id           uuid NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  state                text NOT NULL DEFAULT 'closed',
  opened_at            timestamptz,
  opened_reason        text,
  -- No FK: informational pointer to the run that last transitioned the
  -- circuit, not a live reference this row's lifecycle depends on.
  last_run_id          uuid,
  last_transition_at   timestamptz NOT NULL DEFAULT now(),
  -- No FK: informational pointer to the admin who last reset the circuit —
  -- same reasoning as ai_kill_state.updated_by.
  reset_by             uuid,
  reset_at             timestamptz,
  PRIMARY KEY (org_id, agent_id),
  CONSTRAINT ai_agent_circuit_state_state_chk CHECK (state IN ('closed', 'open')),
  -- Dual-axis integrity, the llm_egress_events / ai_unattended_exposure
  -- pattern: a row cannot name an org that belongs to a different partner
  -- than the one it bills.
  CONSTRAINT ai_agent_circuit_state_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

-- Covers the agent_id -> ai_agents(id) ON DELETE CASCADE FK: without this,
-- every agent delete seq-scans ai_agent_circuit_state. Mirrors the Drizzle
-- schema's ai_agent_circuit_state_agent_idx (aiAgentCircuitState.ts).
CREATE INDEX IF NOT EXISTS ai_agent_circuit_state_agent_idx
  ON ai_agent_circuit_state(agent_id);

-- RLS shape 1 (direct org_id column) — verbatim template, llm_egress_events.
ALTER TABLE ai_agent_circuit_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_circuit_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_circuit_state_isolation ON ai_agent_circuit_state;
CREATE POLICY ai_agent_circuit_state_isolation ON ai_agent_circuit_state
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_circuit_state TO breeze_app;
