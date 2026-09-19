-- script_proposals + script_proposal_reviews (AI script authoring W01b, spec
-- §4.1/§5). Both RLS shape 1 (direct org_id, auto-discovered by
-- rls-coverage.integration.test.ts). DDL only — no row writes, so no
-- breeze.scope elevation is required in this file.
--
-- FK RULES (spec §5): the ONLY hard FK between the two new tables is
-- reviews -> proposals, composite on (proposal_id, org_id) and DEFERRABLE
-- INITIALLY IMMEDIATE because org merge runs SET CONSTRAINTS ALL DEFERRED.
-- proposals.intent_id, .supersedes_id, .promoted_script_id and
-- .promoted_version_id are BARE uuids: the referenced rows change org or die on
-- different schedules, and a self-referencing supersedes_id FK would put a
-- cycle in tenantCascade's topological order.
--
-- Registration (same PR): CORE_ORG_CASCADE_DELETE_ORDER (reviews BEFORE
-- proposals), AUDIT_ADMIN_REQUIRED_TABLES (reviews), CORE_TENANT_EXPORT_POLICY
-- (both), orgMergeRegistry (proposals = custom + fence, reviews =
-- leave-for-erasure).

DO $$ BEGIN
  CREATE TYPE script_proposal_status AS ENUM (
    'proposed','scan_rejected','review_failed','reviewed',
    'approved','rejected','changes_requested','expired','superseded',
    'executed','verified','verification_failed','promoted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS script_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  author_kind TEXT NOT NULL,
  session_id UUID REFERENCES ai_sessions(id) ON DELETE SET NULL,
  -- Agent runs are left for source-org erasure and never repointed, so this is
  -- a typed reference, not an FK (same rule as action_intents).
  agent_run_id UUID,
  language script_language NOT NULL,
  content TEXT NOT NULL,
  content_digest CHAR(64) NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  run_as TEXT NOT NULL DEFAULT 'system',
  goal TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  verification JSONB NOT NULL,
  rollback_note TEXT,
  target_device_ids UUID[] NOT NULL,
  scanner_version TEXT NOT NULL,
  basic_hits TEXT[] NOT NULL DEFAULT '{}',
  strict_hits TEXT[] NOT NULL DEFAULT '{}',
  touch_classes TEXT[] NOT NULL DEFAULT '{}',
  status script_proposal_status NOT NULL DEFAULT 'proposed',
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_id UUID,
  risk_tier TEXT,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  intent_id UUID,
  verified_at TIMESTAMPTZ,
  verification_result JSONB,
  promoted_script_id UUID,
  promoted_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- The composite target the reviews FK references.
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_id_org_uk UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_author_kind_chk
    CHECK (author_kind IN ('chat_session','agent_run'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_run_as_chk
    CHECK (run_as IN ('system','user'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_timeout_chk
    CHECK (timeout_seconds BETWEEN 1 AND 3600);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_targets_chk
    CHECK (array_length(target_device_ids, 1) BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_risk_tier_chk
    CHECK (risk_tier IS NULL OR risk_tier IN ('low','medium','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_content_size_chk
    CHECK (octet_length(content) <= 65536);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS script_proposals_org_created_idx ON script_proposals (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS script_proposals_org_status_idx ON script_proposals (org_id, status);
-- Partial: the runnability check reads "is this proposal already consumed?".
CREATE INDEX IF NOT EXISTS script_proposals_unconsumed_idx ON script_proposals (org_id, expires_at)
  WHERE intent_id IS NULL;

-- Immutability: everything the reviewer saw and everything the digest pins.
-- Lifecycle columns (status, risk_tier, decided_*, intent_id, verified_*,
-- promoted_*) are deliberately NOT listed — those are exactly what state
-- transitions and the org-merge fence mutate.
CREATE OR REPLACE FUNCTION script_proposals_block_content_update() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.author_kind IS DISTINCT FROM OLD.author_kind
     OR NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
     OR NEW.timeout_seconds IS DISTINCT FROM OLD.timeout_seconds
     OR NEW.run_as IS DISTINCT FROM OLD.run_as
     OR NEW.goal IS DISTINCT FROM OLD.goal
     OR NEW.expected_effect IS DISTINCT FROM OLD.expected_effect
     OR NEW.verification IS DISTINCT FROM OLD.verification
     OR NEW.rollback_note IS DISTINCT FROM OLD.rollback_note
     OR NEW.target_device_ids IS DISTINCT FROM OLD.target_device_ids
     OR NEW.scanner_version IS DISTINCT FROM OLD.scanner_version
     OR NEW.basic_hits IS DISTINCT FROM OLD.basic_hits
     OR NEW.strict_hits IS DISTINCT FROM OLD.strict_hits
     OR NEW.touch_classes IS DISTINCT FROM OLD.touch_classes
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'script proposal content is immutable';
  END IF;
  -- session_id is the ONE identity column that may change, and only from
  -- NULL: the chat SDK's post-tool hook back-fills it once the proposal id
  -- is known (the tool handler itself never sees the Breeze session id).
  -- The ai_sessions ON DELETE SET NULL cascade is the other legitimate writer.
  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     AND OLD.session_id IS NOT NULL
     AND NEW.session_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'script proposal session_id can only be set once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'script_proposals_immutable_trg') THEN
    CREATE TRIGGER script_proposals_immutable_trg BEFORE UPDATE ON script_proposals
      FOR EACH ROW EXECUTE FUNCTION script_proposals_block_content_update();
  END IF;
END $$;

ALTER TABLE script_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON script_proposals;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_proposals;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_proposals;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_proposals;
CREATE POLICY breeze_org_isolation_select ON script_proposals FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON script_proposals FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON script_proposals FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON script_proposals FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON script_proposals TO breeze_app;

-- ---------------------------------------------------------------------------
-- script_proposal_reviews — append-only evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS script_proposal_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  proposal_id UUID NOT NULL,
  reviewer_kind TEXT NOT NULL,
  model TEXT,
  reviewer_prompt_version TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  risk_tier TEXT,
  goal_match TEXT,
  reversible BOOLEAN,
  verification_adequate BOOLEAN,
  recommended_action TEXT,
  verdict JSONB,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents NUMERIC(12,4),
  budget_reservation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_proposal_org_fk
    FOREIGN KEY (proposal_id, org_id) REFERENCES script_proposals(id, org_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_kind_chk
    CHECK (reviewer_kind IN ('static_scan','model'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_status_chk
    CHECK (status IN ('completed','failed','timeout'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_risk_tier_chk
    CHECK (risk_tier IS NULL OR risk_tier IN ('low','medium','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_goal_match_chk
    CHECK (goal_match IS NULL OR goal_match IN ('yes','partial','no'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_action_chk
    CHECK (recommended_action IS NULL OR recommended_action IN ('approve','changes','reject'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_summary_len_chk
    CHECK (summary IS NULL OR char_length(summary) <= 600);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spec §4.1: the LATEST review is derived, not stored as an FK on the proposal
-- (that would be a proposal<->review cycle the cascade order rejects). This is
-- the index that read runs on.
CREATE INDEX IF NOT EXISTS script_proposal_reviews_proposal_created_idx
  ON script_proposal_reviews (proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS script_proposal_reviews_org_idx
  ON script_proposal_reviews (org_id);

CREATE OR REPLACE FUNCTION script_proposal_reviews_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Erasure (breeze_audit_admin, retention flag set) and cascading deletes
    -- from the parent are the only permitted removals.
    IF allow_retention = '1' OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'script proposal reviews are append-only',
    HINT = 'Review evidence cannot be modified or deleted. Retention uses breeze_audit_admin plus breeze.allow_audit_retention=1.';
END;
$$;

DROP TRIGGER IF EXISTS script_proposal_reviews_block_update ON script_proposal_reviews;
CREATE TRIGGER script_proposal_reviews_block_update
  BEFORE UPDATE ON script_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION script_proposal_reviews_append_only();
DROP TRIGGER IF EXISTS script_proposal_reviews_block_delete ON script_proposal_reviews;
CREATE TRIGGER script_proposal_reviews_block_delete
  BEFORE DELETE ON script_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION script_proposal_reviews_append_only();

ALTER TABLE script_proposal_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_proposal_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON script_proposal_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_proposal_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_proposal_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_proposal_reviews;
CREATE POLICY breeze_org_isolation_select ON script_proposal_reviews FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON script_proposal_reviews FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON script_proposal_reviews FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON script_proposal_reviews FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, REFERENCES ON script_proposal_reviews TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON script_proposal_reviews FROM breeze_app;
GRANT SELECT, DELETE ON script_proposal_reviews TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON script_proposal_reviews FROM breeze_audit_admin;
