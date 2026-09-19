-- script_executions gains a first-class proposal source (spec §4.1, D11).
-- No hidden library script is created to satisfy the FK; script_id becomes
-- nullable and a CHECK pins exactly one source per row.
--
-- Snapshot columns are written at dispatch for BOTH sources so readers stop
-- joining `scripts` for language/timeout — the join is why a parentless row
-- was impossible before (staleCommandReaper.ts innerJoins scripts).
--
-- Provenance ids are BARE uuids (no FK): script_executions is device-
-- denormalised and restamped on device move, so a same-org composite FK would
-- abort the move (spec §4.1, schema/scripts.ts + moveOrg.ts).
-- review_risk_tier / review_summary are SNAPSHOTS so device activity still
-- renders after the proposal and its review are erased.
--
-- DDL only: every column is added nullable or with a constant default, so no
-- row-writing statement and therefore no breeze.scope elevation is needed.
-- Registration (same PR): every column below is classified in
-- CORE_TENANT_EXPORT_POLICY. script_executions is already in
-- CORE_ORG_CASCADE_DELETE_ORDER, CORE_DEVICE_CASCADE_DELETE_TABLES and
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES — no change there.

ALTER TABLE script_executions ALTER COLUMN script_id DROP NOT NULL;

ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'library';
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS proposal_id UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS language script_language;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS content_digest CHAR(64);
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS script_version_id UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS review_id UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS approval_method TEXT;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS review_risk_tier TEXT;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS review_summary VARCHAR(600);

DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_source_kind_chk
    CHECK (source_kind IN ('library','proposal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Exactly one source. Written as two biconditionals rather than an OR so a row
-- that names BOTH a script and a proposal is rejected too.
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_library_source_chk
    CHECK ((source_kind = 'library') = (script_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_proposal_source_chk
    CHECK ((source_kind = 'proposal') = (proposal_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_approval_method_chk
    CHECK (approval_method IS NULL OR approval_method IN
      ('supervised_self','four_eyes','unattended_reviewer_gated','direct_ui','automation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_review_risk_tier_chk
    CHECK (review_risk_tier IS NULL OR review_risk_tier IN ('low','medium','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS script_executions_proposal_idx
  ON script_executions (proposal_id)
  WHERE proposal_id IS NOT NULL;
