-- Wave F tenant/RLS hardening:
-- 1. Enforce future deployment_invites rows to use an org_id whose partner_id
--    matches deployment_invites.partner_id.
-- 2. FORCE RLS on tenant-scoped public tables so table owners cannot bypass
--    policies in custom deployments.

CREATE UNIQUE INDEX IF NOT EXISTS organizations_id_partner_id_unique
  ON organizations (id, partner_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'deployment_invites_org_partner_fk'
  ) THEN
    ALTER TABLE deployment_invites
      ADD CONSTRAINT deployment_invites_org_partner_fk
      FOREIGN KEY (org_id, partner_id)
      REFERENCES organizations (id, partner_id)
      NOT VALID;
  END IF;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH tenant_tables AS (
      SELECT DISTINCT c.oid, n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN information_schema.columns col
        ON col.table_schema = n.nspname
       AND col.table_name = c.relname
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (
          col.column_name = 'org_id'
          OR c.relname = ANY(ARRAY[
            'organizations',
            'partners',
            'partner_users',
            'users',
            'oauth_clients',
            'oauth_client_partner_grants',
            'oauth_refresh_tokens',
            'oauth_grants',
            'oauth_authorization_codes',
            'oauth_sessions',
            'oauth_interactions',
            'automation_policy_compliance',
            'deployment_devices',
            'deployment_results',
            'patch_job_results',
            'patch_rollbacks',
            'file_transfers',
            'user_sso_identities',
            'push_notifications',
            'mobile_devices',
            'ticket_comments',
            'access_review_items'
          ])
        )
    )
    SELECT nspname, relname
    FROM tenant_tables
  LOOP
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.nspname, r.relname);
  END LOOP;
END $$;
