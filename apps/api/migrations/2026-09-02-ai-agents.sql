-- AI Agents wave 1 (spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md)
-- ai_agents: dual-owner config (org_id XOR partner_id), partner-wide first (#2135).
-- ai_agent_runs: org-scoped ledger (Shape 1) with device_id + denormalized org_id.
-- ai_sessions: third principal branch (agent_id).
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps the file).

-- ============================================
-- ai_agents
-- ============================================
CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  kind text NOT NULL,
  name varchar(120) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'off',
  model varchar(100),
  tool_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  protected_resources jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggers jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipients jsonb NOT NULL DEFAULT '{}'::jsonb,
  instructions text,
  cooldown_seconds integer NOT NULL DEFAULT 900,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  last_updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_one_owner_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_kind_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_kind_chk CHECK (kind IN ('triage', 'patch', 'helpdesk'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_mode_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_mode_chk CHECK (mode IN ('off', 'shadow', 'act'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_instructions_len_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_instructions_len_chk CHECK (instructions IS NULL OR char_length(instructions) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_cooldown_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_cooldown_chk CHECK (cooldown_seconds >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_partner_kind_uq ON ai_agents(partner_id, kind) WHERE org_id IS NULL AND disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_org_kind_uq ON ai_agents(org_id, kind) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_agents_partner_id_idx ON ai_agents(partner_id);
CREATE INDEX IF NOT EXISTS ai_agents_org_id_idx ON ai_agents(org_id);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agents_isolation ON ai_agents;
CREATE POLICY ai_agents_isolation ON ai_agents
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
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agents TO breeze_app;

-- ============================================
-- ai_agent_runs
-- ============================================
CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL,
  session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  trigger_kind text NOT NULL,
  trigger_event_id varchar(64),
  trigger_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key varchar(255) NOT NULL,
  mode_at_start text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  summary text,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  intent_ids uuid[] NOT NULL DEFAULT '{}',
  turn_count integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  error_code varchar(64),
  correlation_id varchar(64),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_trigger_kind_chk' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_trigger_kind_chk CHECK (trigger_kind IN ('alert', 'manual', 'schedule', 'ticket'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_mode_chk' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_mode_chk CHECK (mode_at_start IN ('shadow', 'act'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_status_chk' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_status_chk CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped'));
  END IF;
  -- Tenant-scoped, NOT global: a unique index is enforced BELOW row-level
  -- security, so a global UNIQUE (dedupe_key) would let one org's insert fail
  -- with 23505 against a row it cannot see — a cross-tenant existence oracle
  -- and a denial vector. Dedupe is only ever meaningful inside one org.
  -- Same shape as pax8_orders_dedupe_key_uq (partner_id, dedupe_key).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_org_dedupe_key_uq' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_org_dedupe_key_uq UNIQUE (org_id, dedupe_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_agent_runs_agent_queued_idx ON ai_agent_runs(agent_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_runs_org_queued_idx ON ai_agent_runs(org_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_runs_device_id_idx ON ai_agent_runs(device_id);

-- Immutable-after-insert columns (spec §4.2).
--
-- org_id is deliberately NOT guarded, though the spec lists it. ai_agent_runs
-- denormalizes org_id for RLS and is registered in
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES, so moveOrg.ts re-stamps it in the same
-- transaction that flips devices.org_id. Guarding it here made those two
-- contracts mutually exclusive: the re-stamp raised 23000 and rolled the move
-- back, permanently stranding any device an agent had ever run against.
-- org_id is not defended by this trigger anyway — the RLS WITH CHECK requires
-- breeze_has_org_access on the post-image, so a re-stamp into a foreign org
-- fails 42501 regardless.
CREATE OR REPLACE FUNCTION public.ai_agent_runs_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
     OR NEW.trigger_ref IS DISTINCT FROM OLD.trigger_ref
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.mode_at_start IS DISTINCT FROM OLD.mode_at_start
     OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION 'ai_agent_runs: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_agent_runs_immutable_trg ON ai_agent_runs;
CREATE TRIGGER ai_agent_runs_immutable_trg BEFORE UPDATE ON ai_agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.ai_agent_runs_immutable_guard();

ALTER TABLE ai_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_runs_isolation ON ai_agent_runs;
CREATE POLICY ai_agent_runs_isolation ON ai_agent_runs
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_runs TO breeze_app;

-- ============================================
-- ai_sessions: third principal branch
-- ============================================
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agents(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS ai_sessions_agent_id_idx ON ai_sessions(agent_id) WHERE agent_id IS NOT NULL;

-- "At most one" of three (helper/MCP sessions legitimately have none).
ALTER TABLE ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_single_principal_check;
ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_single_principal_check
  CHECK (((user_id IS NOT NULL)::int + (client_user_id IS NOT NULL)::int + (agent_id IS NOT NULL)::int) <= 1);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_agent_type_check' AND conrelid = 'ai_sessions'::regclass) THEN
    ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_agent_type_check CHECK (type <> 'agent' OR agent_id IS NOT NULL);
  END IF;
END $$;
