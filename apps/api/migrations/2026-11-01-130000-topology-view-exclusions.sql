-- M2 Task 7: scoped, reversible per-view exclusions of canonical topology
-- relationships. A graph child of topology_relationships (not an inventory
-- binding): whole-org merge repoints org_id with constraints deferred and keeps
-- relationship UUIDs, so both composite FKs are DEFERRABLE INITIALLY IMMEDIATE.
-- Actor columns are bare uuids, matching every other topology actor column.
-- Writes no rows.

CREATE TABLE IF NOT EXISTS topology_view_exclusions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  view varchar(16) NOT NULL,
  reason varchar(500) NOT NULL,
  created_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_view_exclusions_pkey PRIMARY KEY (id),
  CONSTRAINT topology_view_exclusions_view_chk CHECK (view IN ('overview','physical','logical')),
  CONSTRAINT topology_view_exclusions_reason_chk CHECK (char_length(reason) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS topology_view_exclusions_active_uniq
  ON topology_view_exclusions (org_id, site_id, relationship_id, view) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS topology_view_exclusions_relationship_idx
  ON topology_view_exclusions (relationship_id, org_id, site_id);

ALTER TABLE topology_view_exclusions DROP CONSTRAINT IF EXISTS topology_view_exclusions_site_scope_fk;
ALTER TABLE topology_view_exclusions ADD CONSTRAINT topology_view_exclusions_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_view_exclusions DROP CONSTRAINT IF EXISTS topology_view_exclusions_relationship_scope_fk;
ALTER TABLE topology_view_exclusions ADD CONSTRAINT topology_view_exclusions_relationship_scope_fk
  FOREIGN KEY (relationship_id, org_id, site_id) REFERENCES topology_relationships (id, org_id, site_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE topology_view_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_view_exclusions FORCE ROW LEVEL SECURITY;

DO $$
DECLARE command text; policy_name text; clause text;
BEGIN
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    policy_name := 'breeze_org_isolation_' || lower(command);
    clause := CASE command
      WHEN 'INSERT' THEN 'WITH CHECK (breeze_has_org_access(org_id))'
      WHEN 'UPDATE' THEN 'USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))'
      ELSE 'USING (breeze_has_org_access(org_id))' END;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
      AND p.tablename = 'topology_view_exclusions' AND p.policyname = policy_name) THEN
      EXECUTE format('CREATE POLICY %I ON public.topology_view_exclusions FOR %s %s', policy_name, command, clause);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.topology_view_exclusions TO breeze_app;
  END IF;
END $$;
