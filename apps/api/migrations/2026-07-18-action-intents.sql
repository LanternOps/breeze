-- 2026-07-18: Action intents & durable approval layer — schema foundation
-- (spec docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md).
--
-- action_intents: org-scoped (Shape 1, direct org_id), durable record of a
-- Tier-3 tool call awaiting/undergoing human approval. Identity/attribution
-- columns plus a block of IMMUTABLE action-content columns (locked by the
-- trigger below — material edits are a new intent, not an update) plus a
-- mutable lifecycle block (status/timestamps/decision/result).
--
-- status/source/event_type are TEXT + CHECK rather than native Postgres ENUM
-- types (unlike elevation_status/approval_status) — this table's lifecycle is
-- expected to gain new terminal/error states as later stages (M365 mutation
-- executors) land, and CHECK-constraint columns are cheaper to extend
-- (DROP CONSTRAINT IF EXISTS + re-add) than ALTER TYPE ... ADD VALUE. Mirrors
-- the m365_connections.profile/status convention introduced in
-- 2026-07-13-m365-control-plane-foundation.sql.
--
-- intent_outbox: transactional outbox, written in the same transaction as the
-- intent row/status transition it announces. System-scoped (no org RLS,
-- workers only) — same shape as device_commands; documented as
-- INTENTIONAL_UNSCOPED in rls-coverage.integration.test.ts. Its FK to
-- action_intents is ON DELETE CASCADE, so org erasure cleans it up for free —
-- no separate entry in tenantCascade.ts's CORE_ORG_CASCADE_DELETE_ORDER.
--
-- approval_requests gains a nullable intent_id FK (ON DELETE CASCADE) beside
-- the existing execution_id / elevation_request_id source links, plus a
-- bound_argument_digest column recording what content a decision approved.
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DO-guarded trigger/constraint creation, DROP POLICY IF EXISTS before
-- each CREATE POLICY. autoMigrate wraps this file in one transaction — no
-- inner BEGIN/COMMIT. gen_random_uuid() is the Postgres 13+ builtin (no
-- pgcrypto, never gen_random_bytes).

CREATE TABLE IF NOT EXISTS action_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requesting_api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('chat','mcp_api')),
  requesting_client_label VARCHAR(255),
  action_name VARCHAR(255) NOT NULL,
  action_version INTEGER NOT NULL DEFAULT 1,
  arguments JSONB NOT NULL DEFAULT '{}',
  argument_digest CHAR(64) NOT NULL,
  target_summary TEXT NOT NULL,
  impact_summary TEXT NOT NULL,
  reason TEXT,
  risk_tier SMALLINT NOT NULL,
  connection_id UUID,
  tenant_id UUID,
  idempotency_key TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','approved','executing','completed','failed','rejected','expired','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_assurance_level SMALLINT,
  decided_via TEXT,
  executed_at TIMESTAMPTZ,
  result JSONB,
  error_code TEXT,
  CONSTRAINT action_intents_one_actor_chk
    CHECK ((requested_by_user_id IS NULL) <> (requesting_api_key_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS action_intents_org_idem_uniq
  ON action_intents (org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS action_intents_org_status_idx
  ON action_intents (org_id, status, expires_at);

-- Immutability trigger: the identity/attribution + content columns listed
-- below (§3.1/§3.4 of the spec) may never change after insert. Material
-- edits are a new intent + new approvals. Lifecycle columns (status,
-- timestamps, decision/result/error) are intentionally NOT checked here —
-- those are exactly the columns state transitions are allowed to mutate.
CREATE OR REPLACE FUNCTION action_intents_block_content_update() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'action_intents_immutable_trg') THEN
    CREATE TRIGGER action_intents_immutable_trg BEFORE UPDATE ON action_intents
      FOR EACH ROW EXECUTE FUNCTION action_intents_block_content_update();
  END IF;
END $$;

-- RLS: direct org_id (Shape 1) — standard org isolation. breeze_has_org_access
-- already grants system scope, so no separate system-only branch is needed
-- (matches the device_link_groups / device_recovery_keys precedent).
ALTER TABLE action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_intents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON action_intents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON action_intents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON action_intents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON action_intents;

CREATE POLICY breeze_org_isolation_select ON action_intents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON action_intents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON action_intents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON action_intents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- intent_outbox: transactional outbox. System-scoped — no RLS policies are
-- created, so under FORCE ROW LEVEL SECURITY only the system DB context
-- (which bypasses RLS via withSystemDbAccessContext) can read/write it, same
-- as device_commands. Workers claim rows under withSystemDbAccessContext.
CREATE TABLE IF NOT EXISTS intent_outbox (
  id BIGSERIAL PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES action_intents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('intent_created','intent_approved')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS intent_outbox_unpublished_idx
  ON intent_outbox (created_at) WHERE published_at IS NULL;

ALTER TABLE intent_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE intent_outbox FORCE ROW LEVEL SECURITY;

-- approval_requests: new nullable intent_id link (one intent fans out to N
-- approver rows) + bound_argument_digest (what content the decision approved).
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS intent_id UUID
  REFERENCES action_intents(id) ON DELETE CASCADE;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS bound_argument_digest CHAR(64);

CREATE INDEX IF NOT EXISTS approval_requests_intent_id_idx
  ON approval_requests (intent_id);

-- At most one of execution_id / elevation_request_id / intent_id may be set.
-- No prior constraint of this shape existed on approval_requests (verified
-- against the shipped migration set) — this is a net-new CHECK, not an
-- extension of an existing one. All-NULL rows (plain MCP step-up / dev-seed
-- approvals with no source link) must remain legal.
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_one_source_chk;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_one_source_chk
  CHECK (
    (execution_id IS NOT NULL)::int
    + (elevation_request_id IS NOT NULL)::int
    + (intent_id IS NOT NULL)::int <= 1
  );
