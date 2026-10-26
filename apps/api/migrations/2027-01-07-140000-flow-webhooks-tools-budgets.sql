-- Tool Catalog W05 (#5215 / #5220) PR A — the webhook delivery log, monthly
-- usage counters, the invoked-flow intent binding and the W5 run columns.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
-- §6.4 / §6.5 / §6.7 / §8 (W5 amendments).
-- Plan: docs/superpowers/plans/ai-mcp/2026-10-26-tool-catalog-w5-webhook-tools-budgets.md
-- Task A2 (Open Decisions 2, 3, 5, 8, 9, 13, 15).
--
-- Tenancy shapes (docs/agents/tenancy-rls.md):
--   flow_webhook_deliveries, flow_usage_counters — the connection_health_incidents
--     shape (2026-12-29-100100-connection-health-incidents.sql): partner_id NOT
--     NULL, org_id NULL for partner-level rows, composite (org_id, partner_id) →
--     organizations(id, partner_id), ONE conditional FOR ALL policy:
--       system OR (org_id IS NOT NULL AND has_org_access(org_id))
--              OR (org_id IS NULL AND has_partner_access(partner_id))
--     so a partner user limited to org A never reads org B's rows, and an org
--     token never reads a partner-level row (an org_unresolved delivery, a
--     partner-owned flow's counters). No partner-wide SELECT branch: both are
--     partner-private (plan quorum Q3).
--   Owner guards (BEFORE INSERT, SECURITY DEFINER, the flow_runs_flow_owner_guard
--   model) keep each row's owner equal to its flow's owner.
--
-- Org merge: both tables are leave-for-erasure (orgMergeRegistry.ts). A moved
-- org flow's counters stay with the loser; the flow starts a fresh row in the
-- survivor (at most one month of extra headroom, stated in the merge note).
--
-- Registrations Task A3 adds (none are made here): CORE_ORG_CASCADE_DELETE_ORDER,
-- CORE_TENANT_EXPORT_POLICY (every column, including every new column on flows,
-- flow_runs, flow_run_steps, action_intents, ai_invocations),
-- orgMergeRegistry.ts, rls-coverage DUAL_AXIS_TENANT_TABLES, and
-- flows.webhook_secret_encrypted in encryptedColumnRegistry.ts (row-bound AAD).
-- Neither new table has a device_id, site_id or ticket_id column.
--
-- W04's file (2027-01-06-130000-flow-runs.sql) is never edited: every CHECK
-- widened here is swapped by name (DROP … IF EXISTS + ADD), and the two trigger
-- functions are CREATE OR REPLACE'd from their newest definition (that file).
-- flow_runs_pre_approvals_chk is deliberately unchanged: webhook and tool runs
-- (triggered_via webhook / ai_tool / mcp / ai_agent) never honour pre-approvals
-- (Decisions 4 and 9), which the existing CHECK already enforces.
--
-- Every FK referencing an org_id column is DEFERRABLE INITIALLY IMMEDIATE; every
-- FK states its ON DELETE. Idempotent; no inner BEGIN/COMMIT; no DML (only
-- nullable or defaulted columns, no backfill, no permission rows), so no
-- system-scope election.
--
-- Rollback: a new migration dropping the two tables and the added columns and
-- restoring the swapped CHECKs and both functions from 2027-01-06-130000-flow-runs.sql.
-- Everything that writes these tables sits behind FLOWS_ENABLED (default off).

-- ============================================
-- 1. flows: webhook secret, auth-failure marker, admission-refusal marker
-- ============================================
-- webhook_secret_encrypted: secretCrypto ciphertext with row-bound AAD
--   (encryptedColumnRegistry: flows.webhook_secret_encrypted). The fingerprint
--   is display / change detection only, never a verifier.
-- webhook_last_auth_failure_*: written at most once a minute by the ingress;
--   unauthenticated failures are never delivery rows (Decision 2).
-- last_admission_refusal_*: a monthly-cap or queue refusal, at most once a
--   minute; drives the banner (runs are refused, the flow is not paused).
ALTER TABLE flows ADD COLUMN IF NOT EXISTS webhook_secret_encrypted text;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS webhook_secret_fingerprint text;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS webhook_secret_rotated_at timestamptz;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS webhook_last_auth_failure_at timestamptz;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS webhook_last_auth_failure_reason text;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS last_admission_refusal_at timestamptz;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS last_admission_refusal_code text;

-- Value lists mirror packages/shared/src/validators/flowWebhooks.ts and
-- flowBudgets.ts; pinned by src/db/schema/flowRuns.checkPins.test.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_webhook_secret_pair_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_webhook_secret_pair_chk
      CHECK ((webhook_secret_encrypted IS NULL) = (webhook_secret_fingerprint IS NULL)
        AND (webhook_secret_encrypted IS NULL) = (webhook_secret_rotated_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_webhook_auth_failure_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_webhook_auth_failure_chk
      CHECK ((webhook_last_auth_failure_reason IS NULL OR webhook_last_auth_failure_reason IN (
          'missing_signature', 'bad_signature', 'stale_timestamp', 'missing_token', 'bad_token', 'bad_delivery_id'
        ))
        AND ((webhook_last_auth_failure_at IS NULL) = (webhook_last_auth_failure_reason IS NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_last_admission_refusal_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_last_admission_refusal_chk
      CHECK ((last_admission_refusal_code IS NULL OR last_admission_refusal_code IN (
          'flow_queue_full', 'flow_monthly_cap_reached', 'owner_monthly_cap_reached'
        ))
        AND ((last_admission_refusal_at IS NULL) = (last_admission_refusal_code IS NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_webhook_secret_len_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_webhook_secret_len_chk
      CHECK (char_length(webhook_secret_encrypted) <= 1024 AND char_length(webhook_secret_fingerprint) <= 128);
  END IF;
END $$;

-- ============================================
-- 2. flow_runs: AI token accounting, agent parent, API-key provenance
-- ============================================
-- parent_agent_run_id / triggered_by_api_key_id: plain uuids, no FK — the agent
-- run is history in its own org (like caused_by_run_id) and the key is
-- provenance only. Both join the immutable set below.
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS ai_tokens_used integer NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS parent_agent_run_id uuid;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS triggered_by_api_key_id uuid;

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_triggered_via_chk;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_triggered_via_chk
  CHECK (triggered_via IN ('ui', 'api', 'ai_tool', 'scheduler', 'event', 'webhook', 'mcp', 'ai_agent'));

-- Every kind ↔ via pair explicit (quorum Q1): flow_runs_pre_approvals_chk keys
-- on triggered_via, so 'mcp' / 'ai_agent' may occur only with kind 'tool', and
-- 'ai_tool' only with 'manual' (W04 run_flow) or 'tool'.
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_via_matches_kind_chk;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_via_matches_kind_chk CHECK (
  ((trigger_kind = 'schedule') = (triggered_via = 'scheduler'))
  AND ((trigger_kind = 'event') = (triggered_via = 'event'))
  AND ((trigger_kind = 'webhook') = (triggered_via = 'webhook'))
  AND (trigger_kind <> 'tool' OR triggered_via IN ('ai_tool', 'mcp', 'ai_agent'))
  AND (trigger_kind <> 'manual' OR triggered_via IN ('ui', 'api', 'ai_tool'))
);

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_error_code_chk;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_error_code_chk
  CHECK (error_code IS NULL OR error_code IN (
    'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
    'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
    'no_eligible_approvers', 'worker_lost', 'cancelled',
    'egress_blocked', 'http_status', 'notify_failed', 'ai_budget_exhausted', 'ai_output_invalid', 'ai_token_cap_reached',
    'run_timeout', 'flow_disabled', 'flows_disabled', 'delegator_inactive', 'org_merged'
  ));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_agent_parent_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_agent_parent_chk
      CHECK ((triggered_via = 'ai_agent') = (parent_agent_run_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_api_key_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_api_key_chk
      CHECK (triggered_by_api_key_id IS NULL OR triggered_via IN ('api', 'mcp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_runs_ai_tokens_chk' AND conrelid = 'flow_runs'::regclass) THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_ai_tokens_chk CHECK (ai_tokens_used >= 0);
  END IF;
END $$;

-- 2027-01-06-130000-flow-runs.sql's definition verbatim plus the two W5
-- provenance columns. ai_tokens_used is mutable (settled per model call).
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
     OR NEW.parent_agent_run_id IS DISTINCT FROM OLD.parent_agent_run_id
     OR NEW.triggered_by_api_key_id IS DISTINCT FROM OLD.triggered_by_api_key_id
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

-- ============================================
-- 3. flow_run_steps: per-step AI usage
-- ============================================
ALTER TABLE flow_run_steps ADD COLUMN IF NOT EXISTS ai_input_tokens integer;
ALTER TABLE flow_run_steps ADD COLUMN IF NOT EXISTS ai_output_tokens integer;
ALTER TABLE flow_run_steps ADD COLUMN IF NOT EXISTS ai_cost_cents integer;

ALTER TABLE flow_run_steps DROP CONSTRAINT IF EXISTS flow_run_steps_error_code_chk;
ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_error_code_chk
  CHECK (error_code IS NULL OR error_code IN (
    'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
    'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
    'no_eligible_approvers', 'worker_lost', 'cancelled',
    'egress_blocked', 'http_status', 'notify_failed', 'ai_budget_exhausted', 'ai_output_invalid', 'ai_token_cap_reached'
  ));

DO $$
BEGIN
  -- All three NULL (not an ai step) or all three non-negative.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_run_steps_ai_usage_chk' AND conrelid = 'flow_run_steps'::regclass) THEN
    ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_ai_usage_chk
      CHECK ((ai_input_tokens IS NULL AND ai_output_tokens IS NULL AND ai_cost_cents IS NULL)
        OR (ai_input_tokens >= 0 AND ai_output_tokens >= 0 AND ai_cost_cents >= 0));
  END IF;
END $$;

-- ============================================
-- 4. flow_webhook_deliveries — the authenticated delivery log (Decision 2)
-- ============================================
-- One row per AUTHENTICATED delivery; unauthenticated failures are never rows.
-- Never a body: only its sha256, its size and a resolver value (≤ 256 chars).
-- Accepted rows live as long as their run (the delivery → run mapping is as
-- permanent as flow_runs_dedupe_uq); non-accepted rows are pruned after
-- FLOW_WEBHOOK_DELIVERY_RETENTION_DAYS by jobs/flowRunRetention.ts.
CREATE TABLE IF NOT EXISTS flow_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL for an org_unresolved delivery of a partner-wide flow.
  org_id uuid,
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1,
  auth_mode text NOT NULL,
  delivery_id text,
  -- sha256 hex of the verified signature header (hmac mode only).
  signature_digest text,
  body_sha256 text NOT NULL,
  body_bytes integer NOT NULL,
  status text NOT NULL,
  refusal_code text,
  resolver_value text,
  run_id uuid,
  CONSTRAINT flow_webhook_deliveries_org_partner_fk FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT flow_webhook_deliveries_run_fk FOREIGN KEY (run_id, org_id) REFERENCES flow_runs(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_status_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_status_chk
      CHECK (status IN ('accepted', 'org_unresolved', 'refused', 'invalid_body'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_auth_mode_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_auth_mode_chk
      CHECK (auth_mode IN ('hmac', 'token'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_signature_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_signature_chk
      CHECK ((auth_mode = 'hmac') = (signature_digest IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_accepted_run_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_accepted_run_chk
      CHECK ((status = 'accepted') = (run_id IS NOT NULL) AND (status <> 'accepted' OR org_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_unresolved_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_unresolved_chk
      CHECK (status <> 'org_unresolved' OR org_id IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_delivery_id_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_delivery_id_chk
      CHECK (delivery_id IS NULL OR delivery_id ~ '^[A-Za-z0-9._:-]{1,128}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_digest_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_digest_chk
      CHECK (body_sha256 ~ '^[0-9a-f]{64}$' AND (signature_digest IS NULL OR signature_digest ~ '^[0-9a-f]{64}$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_webhook_deliveries_lengths_chk' AND conrelid = 'flow_webhook_deliveries'::regclass) THEN
    ALTER TABLE flow_webhook_deliveries ADD CONSTRAINT flow_webhook_deliveries_lengths_chk
      CHECK ((resolver_value IS NULL OR char_length(resolver_value) <= 256)
        AND (refusal_code IS NULL OR char_length(refusal_code) <= 64)
        AND body_bytes BETWEEN 0 AND 262144
        AND attempts >= 1);
  END IF;
END $$;

-- Replay protection over ACCEPTED rows only (Decision 2): the signature covers
-- `ts.body` only, so a captured request replayed under a new delivery id still
-- collides on the digest, and a sender's re-signed retry still collides on the
-- delivery id. A refused delivery may be retried and run exactly once later.
CREATE UNIQUE INDEX IF NOT EXISTS flow_webhook_deliveries_sig_uq
  ON flow_webhook_deliveries (flow_id, signature_digest) WHERE status = 'accepted';
CREATE UNIQUE INDEX IF NOT EXISTS flow_webhook_deliveries_delivery_uq
  ON flow_webhook_deliveries (flow_id, delivery_id) WHERE status = 'accepted' AND delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_webhook_deliveries_flow_received_idx
  ON flow_webhook_deliveries (flow_id, received_at DESC);
CREATE INDEX IF NOT EXISTS flow_webhook_deliveries_org_idx
  ON flow_webhook_deliveries (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_webhook_deliveries_partner_idx
  ON flow_webhook_deliveries (partner_id);
CREATE INDEX IF NOT EXISTS flow_webhook_deliveries_run_idx
  ON flow_webhook_deliveries (run_id) WHERE run_id IS NOT NULL;
-- Retention prunes non-accepted rows only.
CREATE INDEX IF NOT EXISTS flow_webhook_deliveries_retention_idx
  ON flow_webhook_deliveries (last_attempt_at) WHERE status <> 'accepted';

-- A delivery belongs to its flow's owner: an org flow's delivery is in that org
-- (and its partner); a partner-wide flow's delivery is under the flow's partner,
-- org_id NULL or one of the partner's orgs (the composite FK). BEFORE INSERT
-- only — org_id, partner_id and flow_id are immutable (below), and org merge
-- leaves rows with the loser. SECURITY DEFINER for the reason
-- flow_runs_flow_owner_guard is: BEFORE ROW triggers fire before the RLS WITH
-- CHECK; an unreadable flow or org is NOT FOUND and refused (fail closed).
CREATE OR REPLACE FUNCTION public.flow_webhook_deliveries_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  flow_org_id uuid;
  flow_partner_id uuid;
  org_partner_id uuid;
BEGIN
  SELECT f.org_id, f.partner_id
  INTO flow_org_id, flow_partner_id
  FROM public.flows AS f
  WHERE f.id = NEW.flow_id;

  IF FOUND THEN
    IF flow_org_id IS NOT NULL THEN
      SELECT o.partner_id INTO org_partner_id
      FROM public.organizations AS o
      WHERE o.id = flow_org_id;
      IF NEW.org_id = flow_org_id AND NEW.partner_id = org_partner_id THEN
        RETURN NEW;
      END IF;
    ELSIF flow_partner_id IS NOT NULL THEN
      IF NEW.partner_id = flow_partner_id THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'flow webhook delivery owner does not match its flow'
    USING ERRCODE = '23514',
          CONSTRAINT = 'flow_webhook_deliveries_owner_chk';
END $$;

DROP TRIGGER IF EXISTS flow_webhook_deliveries_owner_guard_trg ON flow_webhook_deliveries;
CREATE TRIGGER flow_webhook_deliveries_owner_guard_trg
  BEFORE INSERT ON flow_webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.flow_webhook_deliveries_owner_guard();

-- Delivery history is append-only except the coalescing counters: a repeat of
-- the same non-accepted delivery within a minute bumps attempts and
-- last_attempt_at (and may carry a newer refusal_code); a duplicate of an
-- accepted one bumps attempts. Status, run, owner and the authenticated
-- material never change — a refused delivery accepted later is a NEW row.
CREATE OR REPLACE FUNCTION public.flow_webhook_deliveries_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.auth_mode IS DISTINCT FROM OLD.auth_mode
     OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
     OR NEW.signature_digest IS DISTINCT FROM OLD.signature_digest
     OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
     OR NEW.body_bytes IS DISTINCT FROM OLD.body_bytes
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.resolver_value IS DISTINCT FROM OLD.resolver_value
     OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'flow_webhook_deliveries: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS flow_webhook_deliveries_immutable_trg ON flow_webhook_deliveries;
CREATE TRIGGER flow_webhook_deliveries_immutable_trg
  BEFORE UPDATE ON flow_webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.flow_webhook_deliveries_immutable_guard();

-- ============================================
-- 5. flow_usage_counters — exact monthly run counters (Decision 15)
-- ============================================
-- One row per (flow owner, flow, UTC month) plus one owner-total row per
-- (owner, month) with flow_id NULL. Charged by createFlowRun inside the run's
-- own system transaction, under a per-owner advisory lock, only after the run
-- row inserted (a duplicate never charges). Deleted 13 months after the month.
CREATE TABLE IF NOT EXISTS flow_usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL for a partner-owned (partner-wide) flow's rows.
  org_id uuid,
  -- NULL for the owner-total row.
  flow_id uuid REFERENCES flows(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flow_usage_counters_org_partner_fk FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_usage_counters_period_chk' AND conrelid = 'flow_usage_counters'::regclass) THEN
    ALTER TABLE flow_usage_counters ADD CONSTRAINT flow_usage_counters_period_chk
      CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_usage_counters_runs_chk' AND conrelid = 'flow_usage_counters'::regclass) THEN
    ALTER TABLE flow_usage_counters ADD CONSTRAINT flow_usage_counters_runs_chk CHECK (runs >= 0);
  END IF;
END $$;

-- One key for both row kinds; NULLS NOT DISTINCT so two owner-total rows (or
-- two partner-level rows) of one month collide (the wisp_concerns precedent,
-- 2027-01-04-110300-wisp-concerns-watches.sql). The ON CONFLICT target names
-- exactly these columns.
CREATE UNIQUE INDEX IF NOT EXISTS flow_usage_counters_key_uq
  ON flow_usage_counters (partner_id, org_id, flow_id, period_key) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS flow_usage_counters_org_idx
  ON flow_usage_counters (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_usage_counters_flow_idx
  ON flow_usage_counters (flow_id) WHERE flow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_usage_counters_period_idx
  ON flow_usage_counters (period_key);

-- A flow row's owner is its flow's owner: an org flow ⇒ that org (its partner
-- via the composite FK); a partner-wide flow ⇒ org_id NULL under the flow's
-- partner. Owner-total rows (flow_id NULL) are kept honest by the composite FK.
CREATE OR REPLACE FUNCTION public.flow_usage_counters_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  flow_org_id uuid;
  flow_partner_id uuid;
BEGIN
  IF NEW.flow_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f.org_id, f.partner_id
  INTO flow_org_id, flow_partner_id
  FROM public.flows AS f
  WHERE f.id = NEW.flow_id;

  IF FOUND THEN
    IF flow_org_id IS NOT NULL THEN
      IF NEW.org_id = flow_org_id THEN
        RETURN NEW;
      END IF;
    ELSIF flow_partner_id IS NOT NULL THEN
      IF NEW.org_id IS NULL AND NEW.partner_id = flow_partner_id THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'flow usage counter owner does not match its flow'
    USING ERRCODE = '23514',
          CONSTRAINT = 'flow_usage_counters_owner_chk';
END $$;

DROP TRIGGER IF EXISTS flow_usage_counters_owner_guard_trg ON flow_usage_counters;
CREATE TRIGGER flow_usage_counters_owner_guard_trg
  BEFORE INSERT ON flow_usage_counters
  FOR EACH ROW EXECUTE FUNCTION public.flow_usage_counters_owner_guard();

-- ============================================
-- 6. RLS — the conditional connection_health_incidents predicate
-- ============================================
ALTER TABLE flow_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_webhook_deliveries_isolation ON flow_webhook_deliveries;
CREATE POLICY flow_webhook_deliveries_isolation ON flow_webhook_deliveries
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE flow_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_usage_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_usage_counters_isolation ON flow_usage_counters;
CREATE POLICY flow_usage_counters_isolation ON flow_usage_counters
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON flow_webhook_deliveries TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON flow_usage_counters TO breeze_app;
  END IF;
END $$;

-- ============================================
-- 7. action_intents: the invoked-flow binding (Decision 8)
-- ============================================
-- A chat Tier-3 flow-tool call becomes an intent bound to the flow it approved:
-- invoked_flow_id + tool_revision 'flowpub:<publicationId>'. Plain uuid, no FK:
-- intents are retained history and a flow can be deleted. Mutually exclusive
-- with the external-tool binding; either binding carries a revision.
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS invoked_flow_id uuid;

CREATE INDEX IF NOT EXISTS action_intents_invoked_flow_id_idx
  ON action_intents (invoked_flow_id)
  WHERE invoked_flow_id IS NOT NULL;

-- Swapped from 2026-10-16-193700-action-intents-external-tool.sql (the only
-- definition). Existing rows have invoked_flow_id NULL, so they validate.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_external_tool_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_external_tool_chk
  CHECK (num_nonnulls(tool_source_tool_id, invoked_flow_id) <= 1
    AND ((tool_source_tool_id IS NULL AND invoked_flow_id IS NULL) = (tool_revision IS NULL)));

-- The invoked flow is immutable content for the reason tool_source_tool_id is.
-- 2027-01-06-130000-flow-runs.sql's definition verbatim (the newest), plus the
-- invoked_flow_id line. The RAISE text is byte-identical on purpose:
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
     OR NEW.invoked_flow_id IS DISTINCT FROM OLD.invoked_flow_id
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ============================================
-- 8. ai_invocations: the flow run an `ai` step's model call belongs to
-- ============================================
-- Plain uuid (provenance; the run lives in the same org's ledger).
ALTER TABLE ai_invocations ADD COLUMN IF NOT EXISTS flow_run_id uuid;

CREATE INDEX IF NOT EXISTS ai_invocations_flow_run_idx
  ON ai_invocations (flow_run_id)
  WHERE flow_run_id IS NOT NULL;
