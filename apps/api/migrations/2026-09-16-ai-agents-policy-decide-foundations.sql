-- Wave 5 Part A (#3827): inert foundations for a policy-satisfied
-- unattended Tier-3 decision path. Part B (a later PR) is the only thing
-- that ever WRITES the columns/rows this migration adds — this file changes
-- no observable behavior. See the plan header
-- (docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave5-a-foundations.md)
-- for the full inertness contract.
--
-- Three pieces:
--
-- 1. action_intents gains six columns carrying the lifecycle state + safe
--    provenance of a policy decision. `policy_decision_state` DEFAULTs to
--    'human_required' — deliberately the BACKFILL value for every
--    pre-existing row (they all went through human fanout); Part B changes
--    the value createActionIntent STAMPS on a new row's INSERT to
--    'unattempted', it does not touch this column default. The other five
--    are nullable and Part-B-written only; this PR's createActionIntent
--    refactor (Task 4) never writes them.
--
-- 2. ai_unattended_exposure: an org-scoped blast-cap ledger (Shape 1: direct
--    org_id + denormalized partner_id, composite FK to organizations for
--    dual-axis integrity — same shape as llm_egress_events,
--    2026-09-13-c-llm-egress-events.sql, followed verbatim for the RLS
--    policy). No writer exists yet in this PR (Part B adds the reserve/
--    consume paths) — the table is created empty and inert.
--
--    Cascade-order note (Global Constraints): 'ai_unattended_exposure' sorts
--    alphabetically AFTER 'ai_agent_runs'/'ai_agents' (which it references)
--    but the org cascade's actual delete order is computed at RUNTIME from
--    pg_constraint (tenantCascade.ts's topologicalCascadeOrder), not from
--    the hand list's alphabetization. So position-independence is achieved
--    the other way: every FK below carries an EXPLICIT ON DELETE (CASCADE
--    for agent_id/run_id/the org composite, SET NULL for intent_id) so the
--    topo-sort has a real edge to sort on regardless of where the table
--    lands in the hand list.
--
-- 3. ai_kill_state: a system-scoped (no org_id), single-row (id='global')
--    epoch'd kill switch, mirroring abuse_sweep_state verbatim
--    (2026-07-25-abuse-script-hosts.sql:56-78) — forced RLS, one
--    system-only policy, no tenant column. Seeded not-killed (epoch 0) so
--    the guardrail gate this PR's Task 2 adds is a pure pass-through until
--    someone flips it via SQL (no route/service in this PR writes it).
--
-- Idempotent throughout: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT
-- EXISTS, DO-guarded CHECK/policy adds, INSERT ... ON CONFLICT DO NOTHING.
-- No inner BEGIN/COMMIT (autoMigrate wraps the whole file in one transaction).

-- ---------------------------------------------------------------------------
-- 1. action_intents: policy-decision lifecycle + provenance columns
-- ---------------------------------------------------------------------------
--
-- Export policy (tenantExportPolicyRegistry.ts): five of the six are
-- `included` (scalar provenance facts, same tier as decided_via).
-- `policy_authorization_key` is `reviewedIncluded` instead — its name trips
-- SUSPICIOUS_NAME_PARTS ('authorization' substring) even though the value is
-- a POLICY_DECIDABLE_TIER3 registry key ("manage_services:start"), not a
-- credential; the export-policy contract test enforces this at the live
-- schema, which is what caught the misclassification during this task.

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS policy_decision_state text NOT NULL DEFAULT 'human_required';
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS policy_authorization_key text;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS policy_snapshot_digest text;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS policy_classification_version integer;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS policy_reservation_id uuid;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS policy_kill_epoch bigint;

DO $$ BEGIN
  ALTER TABLE action_intents ADD CONSTRAINT action_intents_policy_decision_state_chk
    CHECK (policy_decision_state IN ('unattempted', 'authorized', 'human_required'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deliberately NOT added to action_intents_block_content_update()'s
-- immutable deny-list (2026-08-14-intent-approval-scope-and-deadlines.sql):
-- these six are lifecycle columns Part B's decision path stamps AFTER
-- creation, same category as approval_expires_at/release_by, which that
-- migration's header explains are excluded for the identical reason.

-- ---------------------------------------------------------------------------
-- 2. ai_unattended_exposure: org-scoped blast-cap reservation ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_unattended_exposure (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  partner_id  uuid NOT NULL,
  agent_id    uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  -- No FK: device rows are deleted/moved independently of exposure history
  -- (mirrors ai_agent_runs.device_id's own ON DELETE SET NULL precedent of
  -- decoupling device lifecycle from agent ledgers — here we go further and
  -- carry no FK at all, since this is a point-in-time reservation record,
  -- not a live reference).
  device_id   uuid NOT NULL,
  intent_id   uuid REFERENCES action_intents(id) ON DELETE SET NULL,
  source      text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_unattended_exposure_source_chk CHECK (source IN ('act', 'policy_intent')),
  -- Dual-axis integrity, the llm_egress_events / users pattern: a row cannot
  -- name an org that belongs to a different partner than the one it bills.
  CONSTRAINT ai_unattended_exposure_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_unattended_exposure_org_reserved_idx
  ON ai_unattended_exposure(org_id, reserved_at DESC);
CREATE INDEX IF NOT EXISTS ai_unattended_exposure_agent_reserved_idx
  ON ai_unattended_exposure(agent_id, reserved_at DESC);

-- RLS shape 1 (direct org_id column) — verbatim template, llm_egress_events.
ALTER TABLE ai_unattended_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_unattended_exposure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_unattended_exposure_isolation ON ai_unattended_exposure;
CREATE POLICY ai_unattended_exposure_isolation ON ai_unattended_exposure
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_unattended_exposure TO breeze_app;

-- Retention: none in this PR — no writer exists yet, so there is nothing to
-- sweep. Part B, which adds the reserve/consume paths, also owns the
-- retention sweep for this table.

-- ---------------------------------------------------------------------------
-- 3. ai_kill_state: system-scoped, single-row, epoch'd kill switch
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_kill_state (
  id         text PRIMARY KEY DEFAULT 'global',
  killed     boolean NOT NULL DEFAULT false,
  epoch      bigint NOT NULL DEFAULT 0,
  reason     text,
  -- No FK: may be flipped via SQL directly by ops, without going through a
  -- route that could resolve/validate a user id.
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_kill_state_id_chk CHECK (id = 'global')
);

ALTER TABLE ai_kill_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_kill_state FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_kill_state'
      AND policyname = 'ai_kill_state_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY ai_kill_state_system_only
        ON ai_kill_state
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;

-- No explicit GRANT here — abuse_sweep_state's migration (template) has
-- none either; ensureAppRole's blanket `GRANT ... ON ALL TABLES IN SCHEMA
-- public TO breeze_app` (re-run right after migrations, autoMigrate.ts step
-- 7b) covers it, and the forced RLS system-only policy is what actually
-- gates access regardless of table-level privilege.

-- Seed the single row, not-killed, epoch 0. Default pass — nothing in this
-- PR flips it; the only flip surface is a direct SQL UPDATE (Task 2's
-- bumpAiKillState is added but called by nobody yet).
DO $$
BEGIN
  -- ai_kill_state is FORCE ROW LEVEL SECURITY and FORCE applies to the table
  -- owner too. A migration carries no request context (no breeze.scope set),
  -- so the plain INSERT below is denied under a non-superuser migrator (the
  -- hosted DO-managed doadmin role — autoMigrate.ts:117). Take the system
  -- branch explicitly. `true` = transaction-local, reverted with this block.
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_kill_state (id, killed, epoch) VALUES ('global', false, 0)
    ON CONFLICT (id) DO NOTHING;
END$$;
