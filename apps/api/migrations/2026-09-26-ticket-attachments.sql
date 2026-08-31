-- ticket_attachments (W08, #3902): photo / PDF attachments on ticket comments.
-- Tenancy shape 1 (direct org_id, denormalised from tickets.org_id; RLS
-- auto-discovered). Bytes live in S3 (storage_key) when the platform bucket
-- is configured, else inline in `data` (bytea). comment_id NULL = pending
-- upload not yet claimed by a comment (reaped after 24h).
-- Registered in CORE_ORG_CASCADE_DELETE_ORDER, CORE_TENANT_EXPORT_POLICY,
-- TICKET_ORG_DENORMALIZED_TABLES and CUSTOM_ORG_REWRITE_TABLES in the same PR.
-- Idempotent: IF NOT EXISTS / duplicate_object guards; re-applying is a no-op.

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  ticket_id           uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id          uuid REFERENCES ticket_comments(id) ON DELETE CASCADE,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  storage_backend     varchar(8)   NOT NULL,
  storage_key         text,
  data                bytea,
  content_type        varchar(64)  NOT NULL,
  byte_size           integer      NOT NULL,
  original_filename   varchar(255) NOT NULL,
  sha256              char(64)     NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  attached_at         timestamptz
);

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_backend_chk CHECK (
    (storage_backend = 's3' AND storage_key IS NOT NULL AND data IS NULL) OR
    (storage_backend = 'db' AND data IS NOT NULL AND storage_key IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_size_chk
    CHECK (byte_size > 0 AND byte_size <= 10485760);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_attached_chk
    CHECK ((comment_id IS NULL) = (attached_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_idx  ON ticket_attachments (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_attachments_comment_idx ON ticket_attachments (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_pending_idx ON ticket_attachments (uploaded_by_user_id, created_at) WHERE comment_id IS NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_org_idx     ON ticket_attachments (org_id);

ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_attachments;
CREATE POLICY breeze_org_isolation_select ON ticket_attachments
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_attachments;
CREATE POLICY breeze_org_isolation_insert ON ticket_attachments
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_attachments;
CREATE POLICY breeze_org_isolation_update ON ticket_attachments
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_attachments;
CREATE POLICY breeze_org_isolation_delete ON ticket_attachments
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_attachments TO breeze_app;
