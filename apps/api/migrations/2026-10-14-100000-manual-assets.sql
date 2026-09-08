-- Manual asset entry (#4622) — non-networked inventory records.
-- Anything with a network identity (IP/hostname/URL) is a discovered_assets
-- row and belongs to #5213; this table deliberately has no address columns.
-- Tenancy shape 1: direct org_id, breeze_has_org_access(org_id).
-- org_id NOT NULL justification: customer inventory data, not config/policy —
-- there is no coherent partner-wide manual asset.
-- Writes no rows, so no breeze.scope elevation is required.

DO $$ BEGIN
  CREATE TYPE manual_asset_source AS ENUM ('manual','import');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referenced side for the composite link FK below. discovered_assets had no
-- (id, org_id) unique index; without it a cross-org link is representable.
CREATE UNIQUE INDEX IF NOT EXISTS discovered_assets_id_org_id_uniq
  ON public.discovered_assets (id, org_id);

CREATE TABLE IF NOT EXISTS manual_assets (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id                    uuid NOT NULL,
  name                       varchar(255) NOT NULL,
  asset_type                 discovered_asset_type NOT NULL DEFAULT 'unknown',
  manufacturer               varchar(255),
  model                      varchar(255),
  serial_number              varchar(255),
  asset_tag                  varchar(128),
  location                   varchar(255),
  assigned_contact_id        uuid,
  source                     manual_asset_source NOT NULL DEFAULT 'manual',
  linked_device_id           uuid,
  linked_discovered_asset_id uuid,
  notes                      text,
  tags                       text[] NOT NULL DEFAULT '{}',
  retired_at                 timestamptz,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Composite tenant FKs. Every one is DEFERRABLE INITIALLY IMMEDIATE: org merge
-- runs SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements; a non-deferrable constraint aborts the merge with 23503.
DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_site_org_fk
    FOREIGN KEY (site_id, org_id) REFERENCES sites(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_linked_device_org_fk
    FOREIGN KEY (linked_device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_linked_discovered_asset_org_fk
    FOREIGN KEY (linked_discovered_asset_id, org_id) REFERENCES discovered_assets(id, org_id)
    ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_assigned_contact_org_fk
    FOREIGN KEY (assigned_contact_id, org_id) REFERENCES contacts(id, org_id)
    ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS manual_assets_org_idx ON manual_assets(org_id);
CREATE INDEX IF NOT EXISTS manual_assets_org_site_idx ON manual_assets(org_id, site_id);
-- Duplicate-serial hint and the warranty sweep. NOT unique: serials are not
-- globally unique across manufacturers and a hard constraint would block
-- legitimate re-entry (spec, Data model).
CREATE INDEX IF NOT EXISTS manual_assets_org_serial_idx
  ON manual_assets(org_id, upper(serial_number)) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS manual_assets_linked_device_idx
  ON manual_assets(linked_device_id) WHERE linked_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS manual_assets_linked_discovered_asset_idx
  ON manual_assets(linked_discovered_asset_id) WHERE linked_discovered_asset_id IS NOT NULL;

ALTER TABLE manual_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_assets FORCE ROW LEVEL SECURITY;

DO $$
DECLARE policy_cmd text;
BEGIN
  FOREACH policy_cmd IN ARRAY ARRAY['select','insert','update','delete'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'manual_assets'
        AND policyname = 'manual_assets_' || policy_cmd
    ) THEN
      IF policy_cmd = 'insert' THEN
        EXECUTE format(
          'CREATE POLICY manual_assets_%s ON manual_assets FOR %s '
          || 'WITH CHECK (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id))',
          policy_cmd, policy_cmd);
      ELSIF policy_cmd = 'update' THEN
        EXECUTE format(
          'CREATE POLICY manual_assets_%s ON manual_assets FOR %s '
          || 'USING (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id)) '
          || 'WITH CHECK (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id))',
          policy_cmd, policy_cmd);
      ELSE
        EXECUTE format(
          'CREATE POLICY manual_assets_%s ON manual_assets FOR %s '
          || 'USING (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id))',
          policy_cmd, policy_cmd);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Unguarded on purpose (the repo default). A `pg_roles` existence guard would
-- turn a missing breeze_app role into a SILENT success: the migration would be
-- recorded as applied with RLS forced and zero app-role privileges, and the
-- failure would resurface much later as scattered 42501s from the API. Bare, it
-- aborts the migration run loudly with 42704 instead. autoMigrate refuses to
-- run at all without the role (assertAppRoleBootstrapped), so the guard would
-- have been dead code on the sanctioned path anyway.
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON manual_assets TO breeze_app;
