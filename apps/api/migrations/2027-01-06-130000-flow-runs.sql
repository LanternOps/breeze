-- Tool Catalog W04 (#5215 / #5219) — flow publications, runs, the step ledger,
-- and flow-originated action intents.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §6.4 / §6.5 / §8.
-- Plan: docs/superpowers/plans/ai-mcp/2026-10-20-tool-catalog-w4-flow-runner.md Task A2
-- (Open Decisions 1, 2, 4, 9, 15, 16).
--
-- Tenancy shapes (docs/agents/tenancy-rls.md):
--   flow_versions  — follows flows exactly: org_id XOR partner_id
--                    (flow_versions_one_owner_chk), ONE dual-axis FOR ALL
--                    policy plus the additive FOR SELECT partner-wide branch.
--                    The owner is copied from the parent flow and kept equal
--                    by flow_versions_owner_guard_trg (DEFERRABLE INITIALLY
--                    DEFERRED, so org merge may repoint flows and their
--                    publications in either order inside one transaction).
--   flow_runs      — shape 1: org_id NOT NULL, no partner axis (Decision 1).
--   flow_run_steps — shape 1, child of flow_runs via the composite
--                    (run_id, org_id) FK.
--   A run always executes in exactly one org under an org-scoped principal
--   (spec §6.5). A partner-wide SELECT branch on runs would hand every org
--   token of the partner an org-less run's rendered inputs and outputs; with
--   org_id NOT NULL no such row exists. Partner users still see the runs of
--   every org they can access through breeze_has_org_access.
--
-- Org merge: flow_versions repoint with their flow. flow_runs / flow_run_steps
-- are leave-for-erasure: flow_runs.org_id is trigger-immutable
-- (flow_runs_immutable_guard), the ai_agent_runs precedent, and
-- action_intents.org_id is immutable too, so the composite
-- (requesting_flow_run_id, org_id) FK stays consistent. The loser's active
-- runs are cancelled in the flows resolve phase (Task A3).
--
-- Registrations Task A3 adds (none are made here): CORE_ORG_CASCADE_DELETE_ORDER
-- (all three tables), CORE_TENANT_EXPORT_POLICY (every column; every jsonb
-- excludedOpen; lease_token excludedSensitive), orgMergeRegistry.ts (above),
-- rls-coverage DUAL_AXIS_TENANT_TABLES + XOR_OWNERSHIP_DUAL_AXIS_TABLES for
-- flow_versions. flow_runs / flow_run_steps are auto-discovered shape 1. No
-- table here has a device_id, site_id or ticket_id column (the trigger device
-- lives in trigger_payload), so no device/ticket list entry.
--
-- Every FK that references organizations(id) or an org_id column is
-- DEFERRABLE INITIALLY IMMEDIATE (org merge defers constraints). Every FK
-- states its ON DELETE.
--
-- Idempotent (IF NOT EXISTS, pg_constraint-guarded DO blocks, DROP … IF EXISTS
-- + CREATE for policies and triggers, CREATE OR REPLACE FUNCTION). No inner
-- BEGIN/COMMIT. No DML (flows gains only nullable columns; no backfill, no
-- permission rows), so no system-scope election.
--
-- Rollback: a new migration dropping the three tables, the two flows columns
-- and action_intents.requesting_flow_run_id, and restoring the previous CHECK
-- and trigger-function definitions (2026-09-05-a-agent-originated-intents.sql
-- for the CHECKs, 2026-10-16-193700-action-intents-external-tool.sql for the
-- function). The enum value cannot be dropped; it is inert without writers.
-- Everything that writes these tables sits behind FLOWS_ENABLED (default off).

-- ============================================
-- 0. ai_initiator_kind += 'flow' (Open Decision 16)
-- ============================================
-- autoMigrate applies each file inside one transaction. Since Postgres 12,
-- ALTER TYPE … ADD VALUE may run inside a transaction block as long as the new
-- value is not USED before the transaction commits — so nothing below
-- references 'flow' as an ai_initiator_kind (no DEFAULT, CHECK or DML on an
-- ai_initiator_kind column). The repo runs pgvector/pgvector:pg16.
ALTER TYPE public.ai_initiator_kind ADD VALUE IF NOT EXISTS 'flow';

-- ============================================
-- 1. flows: the live publication pointer and the schedule occurrence key
-- ============================================
-- enabled_publication_seq names the flow_versions row (flow_id, publication_seq)
-- that runs pin. Deliberately no FK: flow_versions already references flows,
-- and a back-FK would make the pair circular.
ALTER TABLE flows ADD COLUMN IF NOT EXISTS enabled_publication_seq integer;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS schedule_last_occurrence_key text;

DO $$
BEGIN
  -- Every existing row is a W03 draft (W03 has no enable path), so this
  -- validates without a backfill.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_enabled_publication_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_enabled_publication_chk
      CHECK ((status IN ('enabled', 'paused')) = (enabled_publication_seq IS NOT NULL));
  END IF;
  -- flows_paused_reason_chk (W03) pairs status = 'paused' with a non-null
  -- reason; this one pins the values. Mirrors FLOW_PAUSED_REASONS
  -- (packages/shared/src/validators/flows.ts), pinned by flowRuns.checkPins.test.ts.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_paused_reason_values_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_paused_reason_values_chk
      CHECK (paused_reason IS NULL OR paused_reason IN ('drift', 'binding_drift', 'delegator_inactive', 'org_merged', 'event_dispatch_not_durable'));
  END IF;
END $$;

-- ============================================
-- 2. flow_versions — one immutable publication per enable (Decision 2)
-- ============================================
CREATE TABLE IF NOT EXISTS flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  -- Per flow, never reused: re-enabling unchanged content still publishes a
  -- new row because the delegator, pins and bindings can differ.
  publication_seq integer NOT NULL,
  -- The draft revision this publication snapshots; recorded, not its identity.
  definition_version integer NOT NULL,
  definition jsonb NOT NULL,
  effective_tier smallint NOT NULL,
  -- Enable-time per-step pins (where drift is measured).
  step_pins jsonb NOT NULL,
  -- Pre-approval bindings set at enable by an interactive user (Decision 3).
  pre_approvals jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The delegator. Erasing the user nulls it; the flow then pauses
  -- delegator_inactive at the next slice (Decision 7).
  enabled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_versions_one_owner_chk' AND conrelid = 'flow_versions'::regclass) THEN
    ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_versions_effective_tier_chk' AND conrelid = 'flow_versions'::regclass) THEN
    ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_effective_tier_chk CHECK (effective_tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_versions_publication_seq_chk' AND conrelid = 'flow_versions'::regclass) THEN
    ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_publication_seq_chk CHECK (publication_seq >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_versions_jsonb_shape_chk' AND conrelid = 'flow_versions'::regclass) THEN
    ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_jsonb_shape_chk CHECK (
      jsonb_typeof(definition) = 'object'
      AND jsonb_typeof(step_pins) = 'array'
      AND jsonb_typeof(pre_approvals) = 'array'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_versions_flow_seq_uq' AND conrelid = 'flow_versions'::regclass) THEN
    ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_flow_seq_uq UNIQUE (flow_id, publication_seq);
  END IF;
  -- Composite-FK target for flow_runs (flow_version_id, flow_id): a run can
  -- never pair flow X with flow Y's publication.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_versions_id_flow_uq' AND conrelid = 'flow_versions'::regclass) THEN
    ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_id_flow_uq UNIQUE (id, flow_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS flow_versions_org_id_idx ON flow_versions (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_versions_partner_wide_idx ON flow_versions (partner_id) WHERE org_id IS NULL;

-- Owner guard (model: tool_source_tools_owner_guard_trg, 2026-10-16-193500).
-- DEFERRED rather than IMMEDIATE so org merge's repoint order does not matter:
-- the check runs at commit, against whatever owner the parent flow ends with.
CREATE OR REPLACE FUNCTION public.flow_versions_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  cur_flow_id uuid;
  cur_org_id uuid;
  cur_partner_id uuid;
  parent_org_id uuid;
  parent_partner_id uuid;
BEGIN
  -- Deferred: by commit time the row may have been updated again or deleted
  -- (e.g. by the flow's ON DELETE CASCADE) later in the same transaction, so
  -- check the row as it stands now, not the NEW image this event captured.
  SELECT v.flow_id, v.org_id, v.partner_id
  INTO cur_flow_id, cur_org_id, cur_partner_id
  FROM public.flow_versions AS v
  WHERE v.id = NEW.id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT f.org_id, f.partner_id
  INTO parent_org_id, parent_partner_id
  FROM public.flows AS f
  WHERE f.id = cur_flow_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "flow_versions" violates foreign key constraint "flow_versions_flow_id_fkey"'
      USING ERRCODE = '23503',
            CONSTRAINT = 'flow_versions_flow_id_fkey';
  END IF;

  IF cur_org_id IS DISTINCT FROM parent_org_id
     OR cur_partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'flow version owner differs from parent flow owner'
      USING ERRCODE = '23514',
            CONSTRAINT = 'flow_versions_parent_owner_chk';
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS flow_versions_owner_guard_trg ON flow_versions;
CREATE CONSTRAINT TRIGGER flow_versions_owner_guard_trg
  AFTER INSERT OR UPDATE OF flow_id, org_id, partner_id ON flow_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.flow_versions_owner_guard();

-- A publication is immutable content. The owner columns may move (org merge
-- repoints a moved org flow's publications), and the delegator FK's
-- ON DELETE SET NULL is let through (non-null -> NULL only, never a retarget).
CREATE OR REPLACE FUNCTION public.flow_versions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.flow_id IS DISTINCT FROM OLD.flow_id
     OR NEW.publication_seq IS DISTINCT FROM OLD.publication_seq
     OR NEW.definition_version IS DISTINCT FROM OLD.definition_version
     OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.effective_tier IS DISTINCT FROM OLD.effective_tier
     OR NEW.step_pins IS DISTINCT FROM OLD.step_pins
     OR NEW.pre_approvals IS DISTINCT FROM OLD.pre_approvals
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.enabled_by_user_id IS DISTINCT FROM OLD.enabled_by_user_id AND NEW.enabled_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'flow_versions: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS flow_versions_immutable_trg ON flow_versions;
CREATE TRIGGER flow_versions_immutable_trg
  BEFORE UPDATE ON flow_versions
  FOR EACH ROW EXECUTE FUNCTION public.flow_versions_immutable_guard();

-- ============================================
-- 3. flow_runs — one org, always (Decision 1)
-- ============================================
CREATE TABLE IF NOT EXISTS flow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Composite FK with flow_id (flow_runs_flow_version_fk below).
  flow_version_id uuid NOT NULL,
  definition_version integer NOT NULL,
  trigger_kind text NOT NULL,
  triggered_via text NOT NULL,
  -- Nullable only so retention can prune them (Decision 9); the service
  -- always writes an object.
  trigger_payload jsonb,
  inputs jsonb,
  status text NOT NULL DEFAULT 'queued',
  -- Decision 4, enforced by flow_runs_pre_approvals_chk.
  pre_approvals_honored boolean NOT NULL,
  current_step_id text,
  current_item_index integer,
  resume_seq integer NOT NULL DEFAULT 0,
  -- Durable slice lease (Decision 15): every checkpoint write is conditional
  -- on it, so a late result from a timed-out or superseded slice is discarded.
  lease_token uuid,
  lease_expires_at timestamptz,
  wake_at timestamptz,
  -- Every creation path sets one (manual:, schedule:, event:).
  dedupe_key text NOT NULL,
  chain_depth smallint NOT NULL DEFAULT 0,
  -- Plain uuid, no FK: the causing run may sit in another org's ledger after
  -- a merge.
  caused_by_run_id uuid,
  triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ai_session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  -- Active wall-clock; excludes waiting and awaiting_approval (spec §6.5).
  active_ms bigint NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  bodies_pruned_at timestamptz,
  error_code text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Named CHECKs (text + CHECK, not pg enums, so later waves swap them by name).
-- Value lists mirror packages/shared/src/validators/flowRuns.ts and are pinned
-- by src/db/schema/flowRuns.checkPins.test.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_status_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_status_chk
      CHECK (status IN ('queued', 'running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired'));
  END IF;
  -- 'webhook' and 'tool' are admitted now for W05; W04 never writes them.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_trigger_kind_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_trigger_kind_chk
      CHECK (trigger_kind IN ('manual', 'schedule', 'event', 'webhook', 'tool'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_triggered_via_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_triggered_via_chk
      CHECK (triggered_via IN ('ui', 'api', 'ai_tool', 'scheduler', 'event'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_via_matches_kind_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_via_matches_kind_chk CHECK (
      ((trigger_kind = 'schedule') = (triggered_via = 'scheduler'))
      AND ((trigger_kind = 'event') = (triggered_via = 'event'))
    );
  END IF;
  -- Decision 4 in the database: no AI or API-key caller can directly start a
  -- run that honours a pre-approval.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_pre_approvals_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_pre_approvals_chk
      CHECK (NOT pre_approvals_honored OR triggered_via IN ('ui', 'scheduler', 'event'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_error_code_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_error_code_chk
      CHECK (error_code IS NULL OR error_code IN (
        'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
        'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
        'no_eligible_approvers', 'worker_lost', 'cancelled',
        'run_timeout', 'flow_disabled', 'flows_disabled', 'delegator_inactive', 'org_merged'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_lease_pair_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_lease_pair_chk
      CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));
  END IF;
  -- Chain depth ≤ 3 (spec §6.5); a chained run names its cause.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_chain_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_chain_chk
      CHECK ((chain_depth BETWEEN 0 AND 3) AND ((chain_depth > 0) <= (caused_by_run_id IS NOT NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_finished_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_finished_chk
      CHECK ((status IN ('completed', 'failed', 'cancelled', 'expired')) = (finished_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_awaiting_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_awaiting_chk
      CHECK ((status = 'awaiting_approval') <= (current_step_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_waiting_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_waiting_chk
      CHECK ((status = 'waiting') = (wake_at IS NOT NULL));
  END IF;
  -- Retention prunes finished runs only.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_pruned_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_pruned_chk
      CHECK (bodies_pruned_at IS NULL OR finished_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_error_len_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_error_len_chk
      CHECK (char_length(error) <= 2000);
  END IF;

  -- Composite-FK target for flow_run_steps and action_intents.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_id_org_uq' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_id_org_uq UNIQUE (id, org_id);
  END IF;
  -- A real constraint, not a partial index: ON CONFLICT ON CONSTRAINT cannot
  -- target a partial index, and the dedupe is permanent (Decision 9) so an
  -- at-least-once event redelivered after its run finished never runs again.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_dedupe_uq' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_dedupe_uq UNIQUE (flow_id, org_id, dedupe_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_flow_version_fk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_flow_version_fk
      FOREIGN KEY (flow_version_id, flow_id) REFERENCES flow_versions(id, flow_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS flow_runs_flow_created_idx ON flow_runs (flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flow_runs_org_created_idx ON flow_runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flow_runs_flow_version_idx ON flow_runs (flow_version_id);
CREATE INDEX IF NOT EXISTS flow_runs_active_idx ON flow_runs (status, updated_at)
  WHERE status IN ('queued', 'running', 'waiting', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS flow_runs_retention_idx ON flow_runs (finished_at)
  WHERE bodies_pruned_at IS NULL AND finished_at IS NOT NULL;

-- Runs are history that stays with their org (the ai_agent_runs precedent,
-- 2026-09-06-a-agent-runs-org-immutable.sql). Identity and provenance never
-- change; triggered_by_user_id may only tombstone (the user FK's
-- ON DELETE SET NULL); and a terminal status is final — retention only nulls
-- body columns.
CREATE OR REPLACE FUNCTION public.flow_runs_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
     OR NEW.flow_version_id IS DISTINCT FROM OLD.flow_version_id
     OR NEW.definition_version IS DISTINCT FROM OLD.definition_version
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.triggered_via IS DISTINCT FROM OLD.triggered_via
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.pre_approvals_honored IS DISTINCT FROM OLD.pre_approvals_honored
     OR NEW.chain_depth IS DISTINCT FROM OLD.chain_depth
     OR NEW.caused_by_run_id IS DISTINCT FROM OLD.caused_by_run_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.triggered_by_user_id IS DISTINCT FROM OLD.triggered_by_user_id AND NEW.triggered_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'flow_runs: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('completed', 'failed', 'cancelled', 'expired')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'flow_runs: terminal status is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS flow_runs_immutable_trg ON flow_runs;
CREATE TRIGGER flow_runs_immutable_trg
  BEFORE UPDATE ON flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.flow_runs_immutable_guard();

-- ============================================
-- 4. flow_run_steps — the step ledger
-- ============================================
CREATE TABLE IF NOT EXISTS flow_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Composite FK with org_id (flow_run_steps_run_fk below).
  run_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  step_id text NOT NULL,
  -- NULL outside a for-each; never negative (the attempt index coalesces
  -- NULL to -1).
  item_index integer,
  attempt smallint NOT NULL DEFAULT 1,
  tool text NOT NULL,
  tool_source text NOT NULL,
  tier smallint NOT NULL,
  status text NOT NULL,
  approval_mode text NOT NULL DEFAULT 'none',
  -- Nullable so retention can prune them (Decision 9).
  rendered_input jsonb,
  output jsonb,
  output_truncated boolean NOT NULL DEFAULT false,
  error_code text,
  error text,
  -- No FK: action_intents.requesting_flow_run_id is the FK'd edge; a back-FK
  -- would make the cascade graph cyclic.
  action_intent_id uuid,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_run_fk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_run_fk
      FOREIGN KEY (run_id, org_id) REFERENCES flow_runs(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_status_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_status_chk
      CHECK (status IN ('running', 'awaiting_approval', 'completed', 'failed', 'skipped', 'unknown_outcome', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_tool_source_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_tool_source_chk
      CHECK (tool_source IN ('core', 'tenant', 'builtin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_tier_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_tier_chk CHECK (tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_approval_mode_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_approval_mode_chk
      CHECK (approval_mode IN ('none', 'intent', 'pre_approved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_error_code_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_error_code_chk
      CHECK (error_code IS NULL OR error_code IN (
        'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
        'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
        'no_eligible_approvers', 'worker_lost', 'cancelled'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_intent_pair_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_intent_pair_chk
      CHECK ((approval_mode = 'intent') = (action_intent_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_awaiting_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_awaiting_chk
      CHECK ((status = 'awaiting_approval') <= (approval_mode = 'intent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_approval_tier_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_approval_tier_chk
      CHECK ((approval_mode <> 'none') <= (tier = 3));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_approver_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_approver_chk
      CHECK (approved_by_user_id IS NULL OR approval_mode = 'intent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_finished_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_finished_chk
      CHECK ((status IN ('completed', 'failed', 'skipped', 'unknown_outcome', 'cancelled')) = (finished_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_error_len_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_error_len_chk
      CHECK (char_length(error) <= 2000);
  END IF;
  -- Keeps COALESCE(item_index, -1) in flow_run_steps_attempt_uq collision-free.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_item_index_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_item_index_chk
      CHECK (item_index IS NULL OR item_index >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_attempt_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_attempt_chk CHECK (attempt >= 1);
  END IF;
END $$;

-- The idempotency key of a step attempt.
CREATE UNIQUE INDEX IF NOT EXISTS flow_run_steps_attempt_uq
  ON flow_run_steps (run_id, step_id, COALESCE(item_index, -1), attempt);
CREATE INDEX IF NOT EXISTS flow_run_steps_run_started_idx ON flow_run_steps (run_id, started_at);

-- ============================================
-- 5. RLS
-- ============================================
-- flow_versions: the flows shape verbatim — one dual-axis FOR ALL policy plus
-- the additive SELECT-only own-partner read branch (#4673). The branch is never
-- folded into the FOR ALL policy: Postgres does not consult FOR SELECT policies
-- for UPDATE/DELETE target rows, so an org token reads a partner-wide
-- publication but cannot write it.
ALTER TABLE flow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_versions_isolation ON flow_versions;
CREATE POLICY flow_versions_isolation
  ON flow_versions
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- `=` and not IS NOT DISTINCT FROM: an unset GUC reads NULL and must never match.
DROP POLICY IF EXISTS flow_versions_partner_wide_select ON flow_versions;
CREATE POLICY flow_versions_partner_wide_select
  ON flow_versions
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- flow_runs / flow_run_steps: shape 1, the action_intents
-- (2026-07-18-action-intents.sql) four-policy shape. breeze_has_org_access
-- already admits system scope.
ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON flow_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON flow_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON flow_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON flow_runs;

CREATE POLICY breeze_org_isolation_select ON flow_runs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON flow_runs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON flow_runs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON flow_runs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE flow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_run_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON flow_run_steps;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON flow_run_steps;
DROP POLICY IF EXISTS breeze_org_isolation_update ON flow_run_steps;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON flow_run_steps;

CREATE POLICY breeze_org_isolation_select ON flow_run_steps
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON flow_run_steps
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON flow_run_steps
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON flow_run_steps
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_versions TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_runs TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_run_steps TO breeze_app;

-- ============================================
-- 6. action_intents: flow-originated intents
-- ============================================
-- A Tier-3 step that is not pre-approved becomes an intent with
-- source = 'flow', origin_principal_kind = 'flow' and the run as its single
-- actor root. No human requester, like an ai_agent intent.
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS requesting_flow_run_id uuid;

CREATE INDEX IF NOT EXISTS action_intents_requesting_flow_run_id_idx
  ON action_intents (requesting_flow_run_id)
  WHERE requesting_flow_run_id IS NOT NULL;

-- Composite FK: an intent can never be filed under a different org than the
-- run that produced it, even under system context (the
-- requesting_agent_run_id precedent). RESTRICT: intents are retained evidence;
-- a run an intent references cannot be deleted out from under it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'action_intents_requesting_flow_run_fk'
      AND conrelid = 'action_intents'::regclass
  ) THEN
    ALTER TABLE action_intents ADD CONSTRAINT action_intents_requesting_flow_run_fk
      FOREIGN KEY (requesting_flow_run_id, org_id) REFERENCES flow_runs(id, org_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Swaps start from the newest definitions (2026-09-05-a-agent-originated-intents.sql;
-- no later migration redefines these three). Exactly ONE actor root, now a
-- four-way count.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_one_actor_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_one_actor_chk
  CHECK (num_nonnulls(requested_by_user_id, requesting_api_key_id, requesting_agent_run_id, requesting_flow_run_id) = 1);

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_source_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_source_chk
  CHECK (source IN ('chat', 'mcp_api', 'ai_agent', 'flow'));

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_origin_principal_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_origin_principal_kind_chk
  CHECK (origin_principal_kind IN (
    'user_session', 'client_user', 'api_key', 'oauth_grant',
    'agent', 'ai_agent', 'helper', 'system', 'unknown', 'flow'
  ));

-- The flow analogues of action_intents_agent_origin_chk and
-- action_intents_agent_source_chk (both kept as they are): the run link, the
-- origin kind and the source move together. All three columns' NOT NULL /
-- IS NOT NULL forms leave no three-valued-logic hole.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'action_intents_flow_origin_chk'
      AND conrelid = 'action_intents'::regclass
  ) THEN
    ALTER TABLE action_intents ADD CONSTRAINT action_intents_flow_origin_chk
      CHECK ((origin_principal_kind = 'flow') = (requesting_flow_run_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'action_intents_flow_source_chk'
      AND conrelid = 'action_intents'::regclass
  ) THEN
    ALTER TABLE action_intents ADD CONSTRAINT action_intents_flow_source_chk
      CHECK ((source = 'flow') = (origin_principal_kind = 'flow'));
  END IF;
END $$;

-- The originating run is immutable content, for the reason
-- requesting_agent_run_id is: an intent whose attributed run could be swapped
-- after approval would defeat release revalidation. The definition below is
-- 2026-10-16-193700-action-intents-external-tool.sql's verbatim (the newest;
-- no later migration redefines it), plus the requesting_flow_run_id line. The
-- RAISE text is byte-identical on purpose:
-- src/testUtils/actionIntentsTriggerDenyList.ts anchors its parser on it.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.requesting_flow_run_id IS DISTINCT FROM OLD.requesting_flow_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.task_step_key IS DISTINCT FROM OLD.task_step_key
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.script_reviewer_evidence IS DISTINCT FROM OLD.script_reviewer_evidence
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.trigger_ref_id IS DISTINCT FROM OLD.trigger_ref_id
     OR NEW.trigger_key IS DISTINCT FROM OLD.trigger_key
     OR NEW.tool_source_tool_id IS DISTINCT FROM OLD.tool_source_tool_id
     OR NEW.tool_revision IS DISTINCT FROM OLD.tool_revision
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
