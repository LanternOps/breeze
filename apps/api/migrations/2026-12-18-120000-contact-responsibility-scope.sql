-- Canonical scoped contact responsibilities (#8087 spec).
-- Shape 1 tenancy: org_id is mandatory and protected by FORCE RLS.
-- No inner BEGIN/COMMIT: the migration runner owns the transaction.

CREATE TABLE IF NOT EXISTS contact_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  org_id UUID NOT NULL,
  role TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  site_id UUID,
  device_group_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT contact_roles_contact_org_fk
    FOREIGN KEY (contact_id, org_id)
    REFERENCES contacts (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT contact_roles_site_org_fk
    FOREIGN KEY (site_id, org_id)
    REFERENCES sites (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT contact_roles_device_group_org_fk
    FOREIGN KEY (device_group_id, org_id)
    REFERENCES device_groups (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT contact_roles_scope_chk CHECK (
    NOT (site_id IS NOT NULL AND device_group_id IS NOT NULL)
  ),

  CONSTRAINT contact_roles_role_chk CHECK (
    role IN ('billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_roles_exact_assignment_uniq
  ON contact_roles (org_id, contact_id, role, site_id, device_group_id)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS contact_roles_org_role_idx
  ON contact_roles (org_id, role);
CREATE INDEX IF NOT EXISTS contact_roles_site_role_idx
  ON contact_roles (site_id, role) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_roles_device_group_role_idx
  ON contact_roles (device_group_id, role) WHERE device_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_roles_contact_idx
  ON contact_roles (contact_id);

ALTER TABLE contact_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON contact_roles;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contact_roles;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contact_roles;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contact_roles;

CREATE POLICY breeze_org_isolation_select ON contact_roles FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON contact_roles FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON contact_roles FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON contact_roles FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_roles TO breeze_app;

-- Backfill runs as system scope because contact_roles is already FORCE RLS.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  contacts_examined BIGINT;
  assignments_created BIGINT;
  malformed_roles BIGINT;
BEGIN
  SELECT count(*) INTO contacts_examined FROM contacts;

  SELECT count(*) INTO malformed_roles
  FROM contacts c
  CROSS JOIN LATERAL unnest(c.roles) AS r(role)
  WHERE r.role IS NULL
     OR r.role NOT IN ('billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal');

  IF malformed_roles > 0 THEN
    RAISE EXCEPTION
      'contact_roles backfill aborted: % unknown or malformed contact role values found',
      malformed_roles;
  END IF;

  WITH inserted AS (
    INSERT INTO contact_roles (
      contact_id,
      org_id,
      role,
      site_id
    )
    SELECT
      c.id,
      c.org_id,
      r.role,
      c.site_id
    FROM contacts c
    CROSS JOIN LATERAL unnest(c.roles) AS r(role)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO assignments_created FROM inserted;

  RAISE NOTICE
    'contact_roles backfill: contacts examined=%, assignments created=%, malformed roles=0, rows not migrated=0',
    contacts_examined,
    assignments_created;
END $$;
