-- Persist the customer identities allowed to accept/decline a quote from the
-- authenticated portal. Existing sent quotes intentionally have no rows and
-- therefore fail closed until explicitly re-sent/authorized.
--
-- Shape 1 tenancy: direct org_id with forced RLS. The composite FK prevents a
-- recipient row from naming a quote in another organization.

CREATE TABLE IF NOT EXISTS quote_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  email varchar(255) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS quote_recipients_quote_email_uq
  ON quote_recipients(quote_id, email);
CREATE INDEX IF NOT EXISTS quote_recipients_org_idx
  ON quote_recipients(org_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_recipients_quote_id_org_id_fkey'
  ) THEN
    ALTER TABLE quote_recipients
      ADD CONSTRAINT quote_recipients_quote_id_org_id_fkey
      FOREIGN KEY (quote_id, org_id)
      REFERENCES quotes(id, org_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_recipients_email_normalized_chk'
  ) THEN
    ALTER TABLE quote_recipients
      ADD CONSTRAINT quote_recipients_email_normalized_chk
      CHECK (length(email) > 0 AND email = lower(btrim(email)));
  END IF;
END $$;

ALTER TABLE quote_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_recipients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON quote_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON quote_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_update ON quote_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON quote_recipients;

CREATE POLICY breeze_org_isolation_select ON quote_recipients FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON quote_recipients FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON quote_recipients FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON quote_recipients FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON quote_recipients TO breeze_app;
