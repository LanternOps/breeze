CREATE TABLE IF NOT EXISTS accounting_entity_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  breeze_entity_type varchar(20) NOT NULL,
  breeze_entity_id uuid NOT NULL,
  remote_entity_type varchar(20) NOT NULL,
  remote_entity_id text,
  remote_sync_token varchar(64),
  link_status varchar(20) NOT NULL DEFAULT 'suggested',
  sync_status varchar(30) NOT NULL DEFAULT 'pending',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounting_entity_mappings_connection_partner_fk'
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_connection_partner_fk
      FOREIGN KEY (integration_id, partner_id)
      REFERENCES accounting_connections(id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounting_entity_mappings_entity_type_chk'
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_entity_type_chk
      CHECK (breeze_entity_type IN ('org', 'catalog_item', 'invoice', 'payment'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounting_entity_mappings_entity_pair_chk'
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_entity_pair_chk CHECK (
        (breeze_entity_type = 'org' AND remote_entity_type = 'Customer') OR
        (breeze_entity_type = 'catalog_item' AND remote_entity_type = 'Item') OR
        (breeze_entity_type = 'invoice' AND remote_entity_type = 'Invoice') OR
        (breeze_entity_type = 'payment' AND remote_entity_type = 'Payment')
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounting_entity_mappings_link_status_chk'
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_link_status_chk
      CHECK (link_status IN ('suggested', 'confirmed', 'unlinked', 'create_new'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounting_entity_mappings_sync_status_chk'
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_sync_status_chk
      CHECK (sync_status IN ('pending', 'synced', 'error', 'synced_with_tax_variance'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_mappings_breeze_uniq
  ON accounting_entity_mappings(integration_id, breeze_entity_type, breeze_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_mappings_remote_uniq
  ON accounting_entity_mappings(integration_id, remote_entity_type, remote_entity_id)
  WHERE remote_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS accounting_entity_mappings_partner_status_idx
  ON accounting_entity_mappings(partner_id, sync_status);

-- Preserve existing QuickBooks customer-import provenance as confirmed mappings.
-- Run this before enabling the ownership trigger so migrations do not depend on
-- request GUCs while reading the forced-RLS organizations table.
DO $$
DECLARE inserted integer;
BEGIN
  INSERT INTO accounting_entity_mappings (
    integration_id, partner_id, breeze_entity_type, breeze_entity_id,
    remote_entity_type, remote_entity_id, link_status, sync_status
  )
  SELECT c.id, l.partner_id, 'org', l.org_id,
         'Customer', l.external_id, 'confirmed', 'pending'
  FROM organization_external_links l
  JOIN accounting_connections c
    ON c.partner_id = l.partner_id AND c.provider = 'quickbooks'
  WHERE l.system = 'quickbooks'
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted > 0 THEN
    RAISE WARNING 'backfilled % QuickBooks customer accounting mappings', inserted;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_accounting_mapping_entity_partner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.breeze_entity_type = 'org' AND NOT EXISTS (
    SELECT 1 FROM organizations
    WHERE id = NEW.breeze_entity_id AND partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'organization % does not belong to partner %',
      NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  ELSIF NEW.breeze_entity_type = 'catalog_item' AND NOT EXISTS (
    SELECT 1 FROM catalog_items
    WHERE id = NEW.breeze_entity_id AND partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'catalog item % does not belong to partner %',
      NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  ELSIF NEW.breeze_entity_type = 'invoice' AND NOT EXISTS (
    SELECT 1 FROM invoices
    WHERE id = NEW.breeze_entity_id AND partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'invoice % does not belong to partner %',
      NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  ELSIF NEW.breeze_entity_type = 'payment' AND NOT EXISTS (
    SELECT 1
    FROM invoice_payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.id = NEW.breeze_entity_id AND i.partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'payment % does not belong to partner %',
      NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS accounting_entity_mappings_entity_partner_guard
  ON accounting_entity_mappings;
CREATE TRIGGER accounting_entity_mappings_entity_partner_guard
  BEFORE INSERT OR UPDATE OF partner_id, breeze_entity_type, breeze_entity_id
  ON accounting_entity_mappings
  FOR EACH ROW EXECUTE FUNCTION validate_accounting_mapping_entity_partner();

ALTER TABLE accounting_entity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_entity_mappings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON accounting_entity_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON accounting_entity_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON accounting_entity_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON accounting_entity_mappings;

CREATE POLICY breeze_partner_isolation_select ON accounting_entity_mappings
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON accounting_entity_mappings
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON accounting_entity_mappings
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON accounting_entity_mappings
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_entity_mappings TO breeze_app;
