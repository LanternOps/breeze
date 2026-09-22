-- Evidence file on an accept-on-behalf acceptance (#6633, follow-up of spec
-- 2026-09-21 §3/§12). A tech who records a customer's acceptance "on a signed
-- PO" can attach the PO scan / signed PDF so a dispute reviewer does not have
-- to hunt for it elsewhere.
--
-- ONE file per acceptance, stored as columns on the acceptance row (no new
-- table): uploading again replaces the file. Bytes go through the shared blob
-- storage service (services/blobStorage.ts), which picks the backend ONCE at
-- upload time — 's3' (object key, no inline bytes) or 'db' (inline bytea, no
-- key) — so the row needs both a backend column and a bytea fallback. The key
-- is `quote-acceptance-evidence/<uuid>` and carries no tenant identifier
-- (blobStorage spec D8): an org move/merge re-stamps org_id on the row and the
-- object never moves.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + existence-checked FK +
-- DROP CONSTRAINT IF EXISTS / re-add. No inner BEGIN/COMMIT — autoMigrate
-- wraps this file in one transaction. Schema-only: no row is written, so no
-- system-scope election is needed (every existing row has all-NULL evidence
-- columns, which satisfies every CHECK below).

ALTER TABLE quote_acceptances
  ADD COLUMN IF NOT EXISTS evidence_storage_backend text,
  ADD COLUMN IF NOT EXISTS evidence_storage_key text,
  ADD COLUMN IF NOT EXISTS evidence_data bytea,
  ADD COLUMN IF NOT EXISTS evidence_filename text,
  ADD COLUMN IF NOT EXISTS evidence_content_type varchar(64),
  ADD COLUMN IF NOT EXISTS evidence_size_bytes integer,
  ADD COLUMN IF NOT EXISTS evidence_sha256 char(64),
  ADD COLUMN IF NOT EXISTS evidence_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_uploaded_by_user_id uuid;

-- ON DELETE SET NULL, not RESTRICT: an org erasure deletes `users`, and a
-- restricting FK here would abort the cascade with 23503 (same reasoning as
-- recorded_by_user_id in 2026-10-27-100000).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_acceptances_evidence_uploaded_by_user_id_fkey'
      AND conrelid = 'quote_acceptances'::regclass
  ) THEN
    ALTER TABLE quote_acceptances
      ADD CONSTRAINT quote_acceptances_evidence_uploaded_by_user_id_fkey
      FOREIGN KEY (evidence_uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Evidence belongs to an MSP-recorded acceptance only. A customer acceptance
-- is its own record (typed signature + hash) and must never carry an
-- MSP-supplied file.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_evidence_origin_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_evidence_origin_chk
  CHECK (evidence_storage_backend IS NULL OR origin = 'on_behalf');

-- All-or-nothing metadata, and the backend decides where the bytes are: 's3'
-- rows carry a key and no inline bytes, 'db' rows the reverse. The uploader
-- column is deliberately NOT in the group — it is ON DELETE SET NULL and may
-- outlive its user as NULL.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_evidence_shape_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_evidence_shape_chk
  CHECK (
    (evidence_storage_backend IS NULL
      AND evidence_storage_key IS NULL AND evidence_data IS NULL
      AND evidence_filename IS NULL AND evidence_content_type IS NULL
      AND evidence_size_bytes IS NULL AND evidence_sha256 IS NULL
      AND evidence_uploaded_at IS NULL AND evidence_uploaded_by_user_id IS NULL)
    OR (
      evidence_filename IS NOT NULL AND evidence_content_type IS NOT NULL
      AND evidence_size_bytes IS NOT NULL AND evidence_size_bytes > 0
      AND evidence_sha256 IS NOT NULL AND evidence_uploaded_at IS NOT NULL
      AND (
        (evidence_storage_backend = 's3' AND evidence_storage_key IS NOT NULL AND evidence_data IS NULL)
        OR (evidence_storage_backend = 'db' AND evidence_storage_key IS NULL AND evidence_data IS NOT NULL)
      )
    )
  );

COMMENT ON COLUMN quote_acceptances.evidence_storage_key IS
  'Opaque blob-store key (quote-acceptance-evidence/<uuid>) for the on-behalf evidence file when evidence_storage_backend = ''s3''. No tenant identifier. Cleared by the org-erasure object pre-clear (tenantCascade OBJECT_PRECLEAR_TABLES).';
