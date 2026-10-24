-- Agreement requests + signer-evidence snapshot on contract_documents
-- (#8865 W1b; spec docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md §4).
--
-- Idempotent; no inner BEGIN/COMMIT. System scope FIRST: the back-fill below
-- UPDATEs contract_documents, which is FORCE RLS (issue #4518) — without it the
-- UPDATE silently matches zero rows.
SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. agreement_requests — Shape 1, org_id NOT NULL. A per-org transactional
--    record (one client org is asked to sign one agreement), like
--    contract_documents; not a partner-wide config table, so org_id is required.
--    Deliberately NO signed_agreement_id back-reference: together with
--    contract_documents.agreement_request_id it would form an FK cycle that
--    topologicalCascadeOrder() cannot order. The signed agreement is found via
--    contract_documents.agreement_request_id (unique partial index below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'draft',
  template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE RESTRICT,
  template_version_id uuid NOT NULL REFERENCES contract_template_versions(id) ON DELETE RESTRICT,
  contract_id uuid,
  public_link_revoked_at timestamptz,
  label text,
  cover_message text,
  variable_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_name_snapshot varchar(255),
  client_address_snapshot jsonb,
  seller_snapshot jsonb,
  document_locale varchar(16),
  render_locale varchar(16),
  effective_date date,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  expired_at timestamptz,
  decline_reason text,
  void_reason text,
  accept_token_jti varchar(128),
  accept_token_issued_at timestamptz,
  accept_token_expires_at timestamptz,
  accept_token_kid varchar(64),
  public_response_jti varchar(128),
  public_response_consumed_at timestamptz,
  public_response_outcome varchar(16),
  reminder_count integer NOT NULL DEFAULT 0,
  last_reminded_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  voided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_requests_status_chk
    CHECK (status IN ('draft', 'sent', 'viewed', 'signed', 'declined', 'voided', 'expired')),
  CONSTRAINT agreement_requests_outcome_chk
    CHECK (public_response_outcome IS NULL OR public_response_outcome IN ('accepted', 'declined'))
);

-- Target of the recipients' composite (request_id, org_id) FK.
CREATE UNIQUE INDEX IF NOT EXISTS agreement_requests_id_org_uq ON agreement_requests (id, org_id);

-- A request can never file against another org's contract. The column list on
-- SET NULL is required: a bare SET NULL would also null org_id (NOT NULL) and a
-- contract delete would fail. DEFERRABLE so org merge can move parent/child
-- org_id in separate statements. Precedent:
-- 2026-10-15-170000-service-deliverables.sql (service_deliverables_contract_org_fk).
DO $$ BEGIN
  ALTER TABLE agreement_requests ADD CONSTRAINT agreement_requests_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts(id, org_id)
    ON DELETE SET NULL (contract_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS agreement_requests_org_idx ON agreement_requests (org_id);
CREATE INDEX IF NOT EXISTS agreement_requests_org_status_idx ON agreement_requests (org_id, status);
CREATE INDEX IF NOT EXISTS agreement_requests_contract_idx ON agreement_requests (contract_id);
-- The expiry reaper's scan (W2): only open requests can expire.
CREATE INDEX IF NOT EXISTS agreement_requests_open_expiry_idx
  ON agreement_requests (expires_at) WHERE status IN ('sent', 'viewed');

-- ---------------------------------------------------------------------------
-- 2. agreement_request_recipients — Shape 1; mirrors quote_recipients
--    (2026-07-20-portal-quote-recipients.sql).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_request_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  email varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_request_recipients_email_normalized_chk CHECK (email = lower(btrim(email)))
);

DO $$ BEGIN
  ALTER TABLE agreement_request_recipients ADD CONSTRAINT agreement_request_recipients_request_org_fk
    FOREIGN KEY (request_id, org_id) REFERENCES agreement_requests(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agreement_request_recipients_request_email_uq
  ON agreement_request_recipients (request_id, email);
CREATE INDEX IF NOT EXISTS agreement_request_recipients_org_idx ON agreement_request_recipients (org_id);

-- ---------------------------------------------------------------------------
-- 3. RLS: shape 1 (direct org_id, NOT NULL). Four per-command policies per
--    table, exactly 2026-07-16-contract-documents.sql:143-157;
--    breeze_has_org_access() resolves system scope internally.
-- ---------------------------------------------------------------------------
ALTER TABLE agreement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON agreement_requests;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON agreement_requests;
DROP POLICY IF EXISTS breeze_org_isolation_update ON agreement_requests;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON agreement_requests;
CREATE POLICY breeze_org_isolation_select ON agreement_requests
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON agreement_requests
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON agreement_requests
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON agreement_requests
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE agreement_request_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_request_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON agreement_request_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON agreement_request_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_update ON agreement_request_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON agreement_request_recipients;
CREATE POLICY breeze_org_isolation_select ON agreement_request_recipients
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON agreement_request_recipients
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON agreement_request_recipients
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON agreement_request_recipients
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ---------------------------------------------------------------------------
-- 4. contract_documents: durable source discriminator, request link, and the
--    signer-evidence snapshot (so a signed agreement keeps who/when/how after
--    its quote or request is deleted).
-- ---------------------------------------------------------------------------
ALTER TABLE contract_documents
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'quote',
  ADD COLUMN IF NOT EXISTS agreement_request_id uuid,
  ADD COLUMN IF NOT EXISTS signer_name varchar(255),
  ADD COLUMN IF NOT EXISTS signer_email varchar(255),
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signer_ip varchar(64),
  ADD COLUMN IF NOT EXISTS signer_user_agent text,
  ADD COLUMN IF NOT EXISTS acceptance_origin text,
  ADD COLUMN IF NOT EXISTS acceptance_method varchar(32),
  ADD COLUMN IF NOT EXISTS acceptance_reference text,
  ADD COLUMN IF NOT EXISTS recorded_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS content_sha256 char(64),
  ADD COLUMN IF NOT EXISTS content_hash_version smallint,
  ADD COLUMN IF NOT EXISTS acceptance_render_locale varchar(16);

-- SET NULL, not RESTRICT/NO ACTION: agreement_requests sorts BEFORE
-- contract_documents in CORE_ORG_CASCADE_DELETE_ORDER, so org erasure deletes
-- requests first; a blocking FK would abort erasure with 23503. Single-column
-- (agreement_requests.id is the PK) — the composite org guard on this link is
-- the writer, which always files the document under the request's org.
DO $$ BEGIN
  ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_agreement_request_fk
    FOREIGN KEY (agreement_request_id) REFERENCES agreement_requests(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_recorded_by_fk
    FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One signed agreement per request.
CREATE UNIQUE INDEX IF NOT EXISTS contract_documents_agreement_request_uq
  ON contract_documents (agreement_request_id) WHERE agreement_request_id IS NOT NULL;

ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_source_kind_chk;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_source_kind_chk
  CHECK (source_kind IN ('quote', 'request'));

ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_origin_chk;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_origin_chk
  CHECK (acceptance_origin IS NULL OR acceptance_origin IN ('customer', 'on_behalf'));

-- NOT a strict XOR on the two source FKs: both are ON DELETE SET NULL, so after
-- the source row is deleted both are NULL — a strict XOR would raise 23514
-- DURING the parent delete (the recorder_chk trap,
-- 2026-10-27-100000-quote-acceptances-on-behalf.sql:68-77). source_kind is the
-- durable discriminator; the FKs are conveniences that may legitimately go NULL.
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_one_source_chk;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_one_source_chk CHECK (
  NOT (quote_id IS NOT NULL AND agreement_request_id IS NOT NULL)
  AND (source_kind <> 'quote' OR agreement_request_id IS NULL)
  AND (source_kind <> 'request' OR (quote_id IS NULL AND quote_acceptance_id IS NULL))
);

-- ---------------------------------------------------------------------------
-- 5. Back-fill the evidence snapshot from quote_acceptances for every row whose
--    acceptance still resolves. A row whose quote_acceptance_id is already NULL
--    (quote deleted earlier) keeps NULL evidence — nothing is invented.
--    `cd.signed_at IS NULL` makes a replay a no-op. quote_acceptances.signed_at
--    is a naive UTC timestamp; AT TIME ZONE 'UTC' makes it the matching
--    timestamptz.
-- ---------------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE contract_documents cd
     SET signer_name = qa.signer_name,
         signer_email = qa.signer_email,
         signed_at = qa.signed_at AT TIME ZONE 'UTC',
         signer_ip = qa.ip_address,
         signer_user_agent = qa.user_agent,
         acceptance_origin = qa.origin,
         acceptance_method = qa.method,
         acceptance_reference = qa.reference,
         recorded_by_user_id = qa.recorded_by_user_id,
         content_sha256 = qa.quote_sha256,
         content_hash_version = qa.hash_version,
         -- Effective locale the hash was computed with: NULL on a pre-#3777
         -- acceptance means 'en' (quoteAcceptanceVerify.acceptanceRenderLocale).
         acceptance_render_locale = COALESCE(qa.render_locale, 'en')
    FROM quote_acceptances qa
   WHERE cd.quote_acceptance_id = qa.id
     AND cd.signed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled signer evidence onto % contract_documents rows', n;
  END IF;
END $$;
