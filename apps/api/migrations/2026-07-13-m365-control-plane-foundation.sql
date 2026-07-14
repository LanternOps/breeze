-- Evolve the existing direct-M365 table into canonical control-plane metadata.
-- autoMigrate supplies the transaction; do not add BEGIN/COMMIT.
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS profile VARCHAR(64);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(40);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS credential_domain VARCHAR(64);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS vault_ref TEXT;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS credential_version VARCHAR(128);
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS permission_manifest_version INTEGER;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS observed_grants JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(80);

UPDATE m365_connections
SET profile = COALESCE(profile, 'legacy-direct'),
    auth_mode = COALESCE(auth_mode, 'client-secret-legacy'),
    credential_domain = COALESCE(credential_domain, 'legacy-direct'),
    permission_manifest_version = COALESCE(permission_manifest_version, 0)
WHERE profile IS NULL
   OR auth_mode IS NULL
   OR credential_domain IS NULL
   OR permission_manifest_version IS NULL;

ALTER TABLE m365_connections ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN client_secret DROP NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN tenant_id TYPE VARCHAR(36);
ALTER TABLE m365_connections ALTER COLUMN profile SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN auth_mode SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN credential_domain SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN permission_manifest_version SET NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN status SET DEFAULT 'pending-consent';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_connections_user_id_fkey'
      AND conrelid = 'm365_connections'::regclass
  ) THEN
    ALTER TABLE m365_connections
      ADD CONSTRAINT m365_connections_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

UPDATE m365_connections c
SET created_by = NULL
WHERE created_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.created_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_connections_created_by_fkey'
      AND conrelid = 'm365_connections'::regclass
  ) THEN
    ALTER TABLE m365_connections
      ADD CONSTRAINT m365_connections_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_owner_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_owner_check
  CHECK ((org_id IS NOT NULL)::int + (user_id IS NOT NULL)::int = 1);

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_tenant_guid_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_tenant_guid_check
  CHECK (tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_profile_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_profile_check CHECK (profile IN (
  'legacy-direct', 'communications-delegated', 'customer-graph-read',
  'customer-graph-actions', 'customer-exchange-powershell'
));

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_status_check;
UPDATE m365_connections
SET status = 'degraded', last_error_code = 'legacy-status-normalized'
WHERE status NOT IN ('pending-consent', 'verifying', 'active', 'degraded', 'suspended', 'revoked');
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_status_check CHECK (status IN (
  'pending-consent', 'verifying', 'active', 'degraded', 'suspended', 'revoked'
));

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_manifest_version_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_manifest_version_check
  CHECK (
    (profile = 'legacy-direct' AND permission_manifest_version = 0)
    OR (profile <> 'legacy-direct' AND permission_manifest_version >= 1)
  );

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_observed_grants_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_observed_grants_check
  CHECK (jsonb_typeof(observed_grants) = 'array');

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_credential_location_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_credential_location_check CHECK (
  (profile = 'legacy-direct' AND client_secret IS NOT NULL AND vault_ref IS NULL)
  OR
  (profile <> 'legacy-direct' AND client_secret IS NULL AND vault_ref IS NOT NULL AND credential_version IS NOT NULL)
);

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_profile_binding_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_profile_binding_check CHECK (
  (profile = 'legacy-direct' AND org_id IS NOT NULL AND auth_mode = 'client-secret-legacy' AND credential_domain = 'legacy-direct')
  OR (profile = 'communications-delegated' AND user_id IS NOT NULL AND auth_mode = 'delegated' AND credential_domain = 'communications-delegated')
  OR (profile = 'customer-graph-read' AND org_id IS NOT NULL AND auth_mode = 'application-certificate' AND credential_domain = 'customer-graph-read')
  OR (profile = 'customer-graph-actions' AND org_id IS NOT NULL AND auth_mode = 'application-certificate' AND credential_domain = 'customer-graph-actions')
  OR (profile = 'customer-exchange-powershell' AND org_id IS NOT NULL AND auth_mode = 'application-certificate' AND credential_domain = 'customer-exchange-powershell')
);

DROP INDEX IF EXISTS m365_connections_org_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_org_profile_uniq
  ON m365_connections (org_id, profile);
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_user_profile_uniq
  ON m365_connections (user_id, profile);

DROP POLICY IF EXISTS breeze_org_isolation_select ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_select ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_insert ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_update ON m365_connections;
DROP POLICY IF EXISTS breeze_m365_connection_delete ON m365_connections;

ALTER TABLE m365_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_m365_connection_select ON m365_connections FOR SELECT USING (
  public.breeze_has_org_access(org_id)
  OR user_id = public.breeze_current_user_id()
  OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = m365_connections.user_id
      AND (public.breeze_has_partner_access(u.partner_id) OR public.breeze_has_org_access(u.org_id))
  )
);
CREATE POLICY breeze_m365_connection_insert ON m365_connections FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
  OR user_id = public.breeze_current_user_id()
  OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = m365_connections.user_id
      AND (public.breeze_has_partner_access(u.partner_id) OR public.breeze_has_org_access(u.org_id))
  )
);
CREATE POLICY breeze_m365_connection_update ON m365_connections FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
  OR user_id = public.breeze_current_user_id()
  OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = m365_connections.user_id
      AND (public.breeze_has_partner_access(u.partner_id) OR public.breeze_has_org_access(u.org_id))
  )
) WITH CHECK (
  public.breeze_has_org_access(org_id)
  OR user_id = public.breeze_current_user_id()
  OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = m365_connections.user_id
      AND (public.breeze_has_partner_access(u.partner_id) OR public.breeze_has_org_access(u.org_id))
  )
);
CREATE POLICY breeze_m365_connection_delete ON m365_connections FOR DELETE USING (
  public.breeze_has_org_access(org_id)
  OR user_id = public.breeze_current_user_id()
  OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = m365_connections.user_id
      AND (public.breeze_has_partner_access(u.partner_id) OR public.breeze_has_org_access(u.org_id))
  )
);
