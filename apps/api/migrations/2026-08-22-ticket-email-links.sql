-- ticket_email_links: cross-channel email↔ticket association + idempotency ledger.
-- Tenancy shape 1 (direct org_id). partner_id denormalized for the
-- (partner_id, message_id) idempotency claim only. Registered in
-- CORE_ORG_CASCADE_DELETE_ORDER and CORE_TENANT_EXPORT_POLICY in the same PR.
-- Idempotent: IF NOT EXISTS guards throughout; re-applying is a no-op.

CREATE TABLE IF NOT EXISTS ticket_email_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  message_id text NOT NULL,
  comment_id uuid REFERENCES ticket_comments(id) ON DELETE SET NULL,
  origin varchar(20) NOT NULL,
  visibility varchar(10) NOT NULL,
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE ticket_email_links
    ADD CONSTRAINT ticket_email_links_origin_chk
    CHECK (origin IN ('addin_link', 'addin_create', 'inbound', 'backfill'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_email_links
    ADD CONSTRAINT ticket_email_links_visibility_chk
    CHECK (visibility IN ('public', 'internal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_email_links_partner_message_uq
  ON ticket_email_links (partner_id, message_id);
CREATE INDEX IF NOT EXISTS ticket_email_links_ticket_idx
  ON ticket_email_links (ticket_id);

ALTER TABLE ticket_email_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_email_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_email_links;
CREATE POLICY breeze_org_isolation_select ON ticket_email_links
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_email_links;
CREATE POLICY breeze_org_isolation_insert ON ticket_email_links
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_email_links;
CREATE POLICY breeze_org_isolation_update ON ticket_email_links
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_email_links;
CREATE POLICY breeze_org_isolation_delete ON ticket_email_links
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_email_links TO breeze_app;
