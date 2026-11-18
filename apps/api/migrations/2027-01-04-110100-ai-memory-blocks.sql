-- Wisp W03 (#9909, feature #9906): ai_memory_blocks — Wisp's durable memory.
--
-- One row is one remembered thing (a preference, a standing instruction, a
-- fact, a decision, a concern outcome, or a work summary), owned by exactly one
-- of: a user (private to that technician), an org (shared by everyone with that
-- org's access), or the partner (shared partner-wide).
--
-- Tenancy shape: partner-axis anchor with owner sub-axes (composes shapes 3, 1
-- and 6 of docs/agents/tenancy-rls.md). `tenant_partner_id` is the anchor; the
-- RLS policy branches on `owner_kind`:
--   user    → owner_user_id = breeze_current_user_id() AND the anchor is the
--             caller's own partner (shape 6, bounded by the anchor);
--   org     → breeze_has_org_access(owner_org_id)                 (shape 1);
--   partner → breeze_has_partner_access(tenant_partner_id)        (shape 3).
-- There is deliberately no partner-wide SELECT branch for org tokens: this is
-- private memory, not partner config. The partner branch admits any caller with
-- partner access; the stricter WRITE gate for partner-owned blocks
-- (canManagePartnerWidePolicies) is app-layer only, in memoryService.ts — any
-- new request-context writer must call it (the single-caller contract test pins
-- writers to memoryService.ts / memoryBroker.ts). Registered in PARTNER_TENANT_TABLES
-- (rls-coverage.integration.test.ts) with column `tenant_partner_id`; the one
-- FOR ALL policy references breeze_has_partner_access, so all four DML
-- commands are covered.
--
-- Erasure: every owner is bound to the anchor partner by a composite FK with
-- ON DELETE CASCADE, so org-owned rows die with the org row (cascadeDeleteOrg
-- deletes `organizations` last), user-owned rows die with the user row, and
-- partner-owned rows die with the partner row (tenant_partner_id → partners
-- ON DELETE CASCADE) at the end of cascadeDeletePartner.
--
-- Deliberately ABSENT from CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry.ts
-- and CORE_TENANT_EXPORT_POLICY: those engines key on a literal `org_id`
-- column (cascadeDeletePartner's sweep keys on a literal `partner_id`), and this
-- table has neither — listing it would make the engine emit `WHERE org_id = $1`
-- against a column that does not exist. Org merge: not a participant; the
-- loser's org-owned blocks die with the loser shell via the FK (same disposition
-- as fix_memory). If this table is ever registered for tenant export: `content`
-- (jsonb) is `excludedOpen`, and `source_session_id` (a bare uuid provenance
-- pointer) is `included`.
--
-- authored_by_grant_id / authored_by_grant_revision_id carry no FK: they are
-- provenance pointers (like fix_outcomes.device_id). Grants are never
-- hard-deleted except by partner erasure, which removes this table's rows via
-- the anchor FK first.
--
-- DDL only — writes no rows, so no breeze.scope election is needed.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

CREATE TABLE IF NOT EXISTS ai_memory_blocks (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_partner_id             uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  owner_kind                    text NOT NULL,
  owner_user_id                 uuid,
  owner_org_id                  uuid,
  block_type                    text NOT NULL,
  subject_key                   varchar(280) NOT NULL,
  content                       jsonb NOT NULL,
  confidence                    text NOT NULL DEFAULT 'medium',
  status                        text NOT NULL DEFAULT 'unconfirmed',
  authored_by_grant_id          uuid,
  authored_by_grant_revision_id uuid,
  superseded_by_id              uuid REFERENCES ai_memory_blocks(id) ON DELETE SET NULL,
  -- Provenance, never authority (spec §8.1): the ai_sessions turn that wrote
  -- the block. Single-column FK, so no deferrable rule applies. Precedent:
  -- ai_run_artifacts.session_id (2026-10-16-180400-ai-run-artifacts.sql).
  source_session_id             uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_memory_blocks_owner_kind_chk CHECK (owner_kind IN ('user','org','partner')),
  CONSTRAINT ai_memory_blocks_owner_shape_chk CHECK (
    (owner_kind = 'user'    AND owner_user_id IS NOT NULL AND owner_org_id IS NULL)
    OR (owner_kind = 'org'     AND owner_org_id IS NOT NULL AND owner_user_id IS NULL)
    OR (owner_kind = 'partner' AND owner_user_id IS NULL AND owner_org_id IS NULL)
  ),
  CONSTRAINT ai_memory_blocks_block_type_chk CHECK (block_type IN ('preference','standing_instruction','fact','decision','concern_outcome','work_summary')),
  CONSTRAINT ai_memory_blocks_confidence_chk CHECK (confidence IN ('low','medium','high')),
  CONSTRAINT ai_memory_blocks_status_chk CHECK (status IN ('unconfirmed','confirmed','retracted')),
  -- Provenance pair: an agent write stamps both; a human write (recordHumanBlock)
  -- may keep the grant id with no revision; a revision never stands alone.
  CONSTRAINT ai_memory_blocks_grant_provenance_chk CHECK (authored_by_grant_revision_id IS NULL OR authored_by_grant_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Owner ↔ anchor composite FKs. DEFERRABLE INITIALLY IMMEDIATE per the
-- org-merge contract (every composite FK referencing an org/partner pair).
--
-- users (id, partner_id): users_id_partner_id_key already ships from
-- 2026-08-22-office-addin-user-bindings.sql (and is re-issued by the W02
-- wisp-grants migration); IF NOT EXISTS keeps this a no-op and makes the
-- dependency explicit.
-- organizations (id, partner_id): organizations_id_partner_id_unique ships from
-- 2026-05-03-tenant-rls-force-and-invites.sql; not re-created here.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS users_id_partner_id_key ON users (id, partner_id);

DO $$ BEGIN
  ALTER TABLE ai_memory_blocks
    ADD CONSTRAINT ai_memory_blocks_owner_user_partner_fk
    FOREIGN KEY (owner_user_id, tenant_partner_id) REFERENCES users (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_memory_blocks
    ADD CONSTRAINT ai_memory_blocks_owner_org_partner_fk
    FOREIGN KEY (owner_org_id, tenant_partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ai_memory_blocks_tenant_owner_subject_idx
  ON ai_memory_blocks (tenant_partner_id, owner_kind, subject_key);
CREATE INDEX IF NOT EXISTS ai_memory_blocks_owner_user_idx
  ON ai_memory_blocks (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_memory_blocks_owner_org_idx
  ON ai_memory_blocks (owner_org_id) WHERE owner_org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_memory_blocks_grant_idx
  ON ai_memory_blocks (authored_by_grant_id) WHERE authored_by_grant_id IS NOT NULL;
-- W05's 180-day concern_outcome reaper.
CREATE INDEX IF NOT EXISTS ai_memory_blocks_concern_outcome_created_idx
  ON ai_memory_blocks (created_at) WHERE block_type = 'concern_outcome';
-- The source_session_id FK's ON DELETE SET NULL scan on session erasure.
CREATE INDEX IF NOT EXISTS ai_memory_blocks_source_session_idx
  ON ai_memory_blocks (source_session_id) WHERE source_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS — ENABLE + FORCE in the creating file; one FOR ALL policy whose USING
-- and WITH CHECK are identical.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_memory_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory_blocks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_memory_blocks_isolation ON ai_memory_blocks;
CREATE POLICY ai_memory_blocks_isolation ON ai_memory_blocks
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR (owner_kind = 'user'    AND owner_user_id = public.breeze_current_user_id()
                               AND tenant_partner_id = public.breeze_current_partner_id())
    OR (owner_kind = 'org'     AND public.breeze_has_org_access(owner_org_id))
    OR (owner_kind = 'partner' AND public.breeze_has_partner_access(tenant_partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (owner_kind = 'user'    AND owner_user_id = public.breeze_current_user_id()
                               AND tenant_partner_id = public.breeze_current_partner_id())
    OR (owner_kind = 'org'     AND public.breeze_has_org_access(owner_org_id))
    OR (owner_kind = 'partner' AND public.breeze_has_partner_access(tenant_partner_id))
  );

-- DELETE is granted because partner erasure hard-deletes as breeze_app under a
-- system RLS context (withSystemDbAccessContext sets the scope GUC only; it
-- does not switch role) — see 2026-08-22-office-addin-user-bindings.sql.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_memory_blocks TO breeze_app;
