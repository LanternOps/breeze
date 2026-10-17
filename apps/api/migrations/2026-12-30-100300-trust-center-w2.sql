-- Trust Center W2 foundation (#8770 W02a; spec docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md
-- §9 W2 tables, §12, §14, §19 items 25–36; plan docs/superpowers/plans/2026-10-17-trust-center-w2.md Task 3).
--
-- TENANCY: shape 1 (direct org_id NOT NULL) for all five new tables, like W1: each row belongs to exactly one
-- org's trust page (spec §9: a trust page is one org's public identity, not an inheritable policy — the
-- partner-wide template is a separate shape-3 table, W02g). RLS enabled + forced + the four
-- breeze_org_isolation_* policies below, in this migration. Every composite FK that names org_id is
-- DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL DEFERRED).
--
-- REGISTRATIONS (same PR): CORE_ORG_CASCADE_DELETE_ORDER (tenantCascade.ts), orgMergeRegistry.ts (repoint list
-- "Children of trust_pages" — the trust_pages custom executor deletes the loser's page, so these cascade away),
-- CORE_TENANT_EXPORT_POLICY (tenantExportPolicyRegistry.ts: token_hash excludedSensitive, sha256 digests
-- reviewedIncluded), ORG_ID_BENIGN_TRIGGERS for the declaration immutability trigger.
--
-- FK DELETE BEHAVIOUR:
--   (trust_page_id, org_id) → trust_pages(id, org_id)          ON DELETE CASCADE   (declarations, requests, FAQ, subprocessors)
--   (request_id, org_id) → trust_page_access_requests(id, org_id) ON DELETE CASCADE (tokens)
--   (evidence_document_id, org_id) → org_documents(id, org_id)  ON DELETE SET NULL (evidence_document_id) — the
--       declaration survives a hard document delete; evidence_document_sha256 keeps the digest.
--   *_user_id → users(id)                                     ON DELETE SET NULL
--   org_id → organizations(id)                                NO ACTION (org erasure deletes children first)
--
-- SCOPE: this file DELETEs unconfirmed trust_page_documents rows (step 3), so it elects system scope first;
-- under FORCE RLS an unscoped DELETE would silently match zero rows (migrations/README.md, #4518).
-- Idempotent; no inner BEGIN/COMMIT.

SELECT set_config('breeze.scope', 'system', true);

-- 2. Enums. Expiry is always computed from timestamps; it is never a status value.
DO $$ BEGIN
  CREATE TYPE trust_access_request_status AS ENUM ('pending_verification', 'pending_approval', 'approved', 'denied', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE trust_access_token_purpose AS ENUM ('verify_email', 'download');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE trust_subprocessor_source AS ENUM ('manual', 'security_product', 'backup', 'm365');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. trust_page_documents: every linked document — public OR gated — carries a disclosure confirmation
-- (amendment 35). W1 only required it for public links, so a gated row could exist unconfirmed; remove those
-- first so the new CHECK cannot crash-loop autoMigrate on a database holding one (the v0.122.0 lesson).
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM trust_page_documents WHERE disclosure_confirmed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'trust_page_documents: removed % unconfirmed links', n; END IF;
  ALTER TABLE trust_page_documents DROP CONSTRAINT IF EXISTS trust_page_documents_public_confirmed_chk;
  ALTER TABLE trust_page_documents DROP CONSTRAINT IF EXISTS trust_page_documents_confirmed_chk;
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_confirmed_chk
    CHECK (disclosure_confirmed_at IS NOT NULL);
END $$;

-- 4. trust_pages: the inheritable settings become nullable with no default (NULL = inherit from the partner
-- template, then the built-in default; resolveEffectiveTrustSettings). Existing rows keep their explicit values.
ALTER TABLE trust_pages ALTER COLUMN search_indexable DROP NOT NULL, ALTER COLUMN search_indexable DROP DEFAULT;
ALTER TABLE trust_pages ALTER COLUMN show_percentages DROP NOT NULL, ALTER COLUMN show_percentages DROP DEFAULT;
ALTER TABLE trust_pages ALTER COLUMN show_device_count DROP NOT NULL, ALTER COLUMN show_device_count DROP DEFAULT;
ALTER TABLE trust_pages ALTER COLUMN show_managed_by DROP NOT NULL, ALTER COLUMN show_managed_by DROP DEFAULT;
ALTER TABLE trust_pages ALTER COLUMN hidden_control_ids DROP NOT NULL, ALTER COLUMN hidden_control_ids DROP DEFAULT;
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS framework_view TEXT[];
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS show_history BOOLEAN;
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS nda_text TEXT;
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS access_request_creates_ticket BOOLEAN NOT NULL DEFAULT FALSE;
-- Mirrors TRUST_NDA_MAX_CHARS (packages/shared/src/validators/trustCenter.ts) — change both together.
ALTER TABLE trust_pages DROP CONSTRAINT IF EXISTS trust_pages_nda_len_chk;
ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_nda_len_chk
  CHECK (nda_text IS NULL OR length(nda_text) <= 10000);

-- 5. trust_page_declarations: a named MSP user's attestation of a declared control (spec §18.2, amendment 27).
-- Lineage is (trust_page_id, control_id) ordered by declared_at; a re-declaration stamps superseded_at on the
-- old row (Open Decision 2: no self-FK).
CREATE TABLE IF NOT EXISTS trust_page_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_page_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  -- Catalog membership (DECLARED_CONTROL_IDS) is validated by the app; the DB only bounds the shape.
  control_id VARCHAR(64) NOT NULL CHECK (control_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 1000),
  evidence_document_id UUID,
  -- Digest of the evidence document at declaration time; survives the SET NULL above.
  evidence_document_sha256 CHAR(64),
  -- The public "Declared by <partner name>" label, captured at declaration and never rewritten.
  declared_by_partner_name VARCHAR(255) NOT NULL,
  declared_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Exactly 365 days (TRUST_DECLARATION_TTL_DAYS). Written as 8760 hours, not '365 days': a day-unit interval
  -- added to a timestamptz follows the session TimeZone across DST, an hour-unit one is absolute, so the CHECK
  -- agrees with the API's millisecond arithmetic whatever the server time zone is.
  expires_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  withdrawn_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trust_page_declarations_expiry_chk CHECK (expires_at = declared_at + interval '8760 hours')
);

DO $$ BEGIN
  ALTER TABLE trust_page_declarations ADD CONSTRAINT trust_page_declarations_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE trust_page_declarations ADD CONSTRAINT trust_page_declarations_evidence_document_org_fk
    FOREIGN KEY (evidence_document_id, org_id) REFERENCES org_documents(id, org_id)
    ON DELETE SET NULL (evidence_document_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trust_page_declarations_id_org_uq ON trust_page_declarations (id, org_id);
-- One active (neither superseded nor withdrawn) declaration per control per page.
CREATE UNIQUE INDEX IF NOT EXISTS trust_page_declarations_active_uq
  ON trust_page_declarations (trust_page_id, control_id) WHERE superseded_at IS NULL AND withdrawn_at IS NULL;
-- The 30-day reminder sweep (W02b).
CREATE INDEX IF NOT EXISTS trust_page_declarations_reminder_idx
  ON trust_page_declarations (expires_at) WHERE superseded_at IS NULL AND withdrawn_at IS NULL AND reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS trust_page_declarations_org_idx ON trust_page_declarations (org_id);

-- Attribution and dates are immutable. FK columns may only be cleared (ON DELETE SET NULL), the lifecycle stamps
-- are one-way NULL→value, withdrawn_by_user_id may be set only together with withdrawn_at, and org_id may change
-- (org merge repoint). Modelled on 2026-12-17-170000-backup-restore-authorizations.sql.
CREATE OR REPLACE FUNCTION public.breeze_trust_page_declarations_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.trust_page_id IS DISTINCT FROM OLD.trust_page_id
     OR NEW.control_id IS DISTINCT FROM OLD.control_id
     OR NEW.statement IS DISTINCT FROM OLD.statement
     OR NEW.evidence_document_sha256 IS DISTINCT FROM OLD.evidence_document_sha256
     OR NEW.declared_by_partner_name IS DISTINCT FROM OLD.declared_by_partner_name
     OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trust_page_declarations: attribution and dates are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id AND NEW.evidence_document_id IS NOT NULL)
     OR (NEW.declared_by_user_id IS DISTINCT FROM OLD.declared_by_user_id AND NEW.declared_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'trust_page_declarations: evidence_document_id and declared_by_user_id may only be cleared'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.withdrawn_by_user_id IS DISTINCT FROM OLD.withdrawn_by_user_id AND NEW.withdrawn_by_user_id IS NOT NULL
     AND NOT (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) THEN
    RAISE EXCEPTION 'trust_page_declarations: withdrawn_by_user_id may only be set together with withdrawn_at'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
     OR (OLD.reminder_sent_at IS NOT NULL AND NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at) THEN
    RAISE EXCEPTION 'trust_page_declarations: superseded_at, withdrawn_at and reminder_sent_at are set once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trust_page_declarations_immutable_trg ON trust_page_declarations;
CREATE TRIGGER trust_page_declarations_immutable_trg
  BEFORE UPDATE ON trust_page_declarations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_trust_page_declarations_immutable();

-- 6. trust_page_access_requests: an outside party's request for gated documents (spec §12; W02d fills the flow).
CREATE TABLE IF NOT EXISTS trust_page_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_page_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  requester_email VARCHAR(320) NOT NULL CHECK (requester_email = lower(requester_email)),
  requester_name VARCHAR(200) NOT NULL,
  requester_company VARCHAR(200) NOT NULL,
  purpose VARCHAR(2000) NOT NULL,
  -- The snapshot the requester saw. No FK: snapshots are pruned.
  snapshot_id UUID,
  nda_text_accepted TEXT CHECK (nda_text_accepted IS NULL OR length(nda_text_accepted) <= 10000),
  nda_text_sha256 CHAR(64),
  nda_accepted_at TIMESTAMPTZ,
  status trust_access_request_status NOT NULL DEFAULT 'pending_verification',
  email_verified_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decision_note VARCHAR(500),
  grant_expires_at TIMESTAMPTZ,
  granted_document_ids UUID[] CHECK (granted_document_ids IS NULL OR cardinality(granted_document_ids) <= 20),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_downloaded_at TIMESTAMPTZ,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trust_page_access_requests_nda_chk CHECK (
    (nda_text_accepted IS NULL) = (nda_accepted_at IS NULL)
    AND (nda_text_accepted IS NULL) = (nda_text_sha256 IS NULL)
  ),
  CONSTRAINT trust_page_access_requests_approved_chk CHECK (
    status <> 'approved'
    OR (email_verified_at IS NOT NULL AND decided_at IS NOT NULL AND grant_expires_at IS NOT NULL AND granted_document_ids IS NOT NULL)
  )
);

DO $$ BEGIN
  ALTER TABLE trust_page_access_requests ADD CONSTRAINT trust_page_access_requests_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Target for the tokens' composite FK (must exist before it).
CREATE UNIQUE INDEX IF NOT EXISTS trust_page_access_requests_id_org_uq ON trust_page_access_requests (id, org_id);
CREATE INDEX IF NOT EXISTS trust_page_access_requests_page_status_idx
  ON trust_page_access_requests (trust_page_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_page_access_requests_org_idx ON trust_page_access_requests (org_id);
-- Retention (requester PII purged 365 days after the last state change, Open Decision 8).
CREATE INDEX IF NOT EXISTS trust_page_access_requests_updated_idx ON trust_page_access_requests (updated_at);

-- 7. trust_page_access_tokens: verify-email and download tokens. Raw tokens are never stored: token_hash is the
-- sha256 hex of a 48-char nanoid that only ever travels in a URL fragment or a POST body (amendment 32).
CREATE TABLE IF NOT EXISTS trust_page_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  purpose trust_access_token_purpose NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_page_access_tokens ADD CONSTRAINT trust_page_access_tokens_request_org_fk
    FOREIGN KEY (request_id, org_id) REFERENCES trust_page_access_requests(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trust_page_access_tokens_hash_uq ON trust_page_access_tokens (token_hash);
CREATE INDEX IF NOT EXISTS trust_page_access_tokens_request_idx ON trust_page_access_tokens (request_id);
CREATE INDEX IF NOT EXISTS trust_page_access_tokens_expires_idx ON trust_page_access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS trust_page_access_tokens_org_idx ON trust_page_access_tokens (org_id);

-- 8. trust_page_faq_items (W02f). Frozen into published_config at publish (Ruling 20).
CREATE TABLE IF NOT EXISTS trust_page_faq_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_page_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  question VARCHAR(300) NOT NULL,
  answer_html TEXT NOT NULL CHECK (length(answer_html) <= 16000),
  sort_order INTEGER NOT NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_page_faq_items ADD CONSTRAINT trust_page_faq_items_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS trust_page_faq_items_page_sort_idx ON trust_page_faq_items (trust_page_id, sort_order);
CREATE INDEX IF NOT EXISTS trust_page_faq_items_org_idx ON trust_page_faq_items (org_id);

-- 9. trust_page_subprocessors (W02f). Manual rows plus prefilled suggestions keyed by source_key.
CREATE TABLE IF NOT EXISTS trust_page_subprocessors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_page_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(200) NOT NULL,
  purpose VARCHAR(300) NOT NULL,
  location VARCHAR(120),
  website_url VARCHAR(2048) CHECK (website_url IS NULL OR website_url ~ '^https://'),
  source trust_subprocessor_source NOT NULL DEFAULT 'manual',
  source_key VARCHAR(120),
  sort_order INTEGER NOT NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_page_subprocessors ADD CONSTRAINT trust_page_subprocessors_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trust_page_subprocessors_source_key_uq
  ON trust_page_subprocessors (trust_page_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS trust_page_subprocessors_page_sort_idx ON trust_page_subprocessors (trust_page_id, sort_order);
CREATE INDEX IF NOT EXISTS trust_page_subprocessors_org_idx ON trust_page_subprocessors (org_id);

-- 10. RLS: shape 1 (direct org_id) on all five new tables, exactly as W1.
ALTER TABLE trust_page_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_declarations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_declarations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_declarations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_declarations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_declarations;
CREATE POLICY breeze_org_isolation_select ON trust_page_declarations FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_declarations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_declarations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_declarations FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_access_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_access_requests;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_access_requests;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_access_requests;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_access_requests;
CREATE POLICY breeze_org_isolation_select ON trust_page_access_requests FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_access_requests FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_access_requests FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_access_requests FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_access_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_access_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_access_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_access_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_access_tokens;
CREATE POLICY breeze_org_isolation_select ON trust_page_access_tokens FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_access_tokens FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_access_tokens FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_access_tokens FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_faq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_faq_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_faq_items;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_faq_items;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_faq_items;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_faq_items;
CREATE POLICY breeze_org_isolation_select ON trust_page_faq_items FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_faq_items FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_faq_items FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_faq_items FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_subprocessors ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_subprocessors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_subprocessors;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_subprocessors;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_subprocessors;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_subprocessors;
CREATE POLICY breeze_org_isolation_select ON trust_page_subprocessors FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_subprocessors FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_subprocessors FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_subprocessors FOR DELETE USING (public.breeze_has_org_access(org_id));

