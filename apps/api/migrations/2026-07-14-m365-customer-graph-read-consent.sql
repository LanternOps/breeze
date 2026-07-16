-- Contract the M365 control-plane rollout and add system-only consent state.
-- autoMigrate supplies the transaction; do not add BEGIN/COMMIT.

ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS consent_attempt_id UUID;
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS grants_verified_at TIMESTAMPTZ;
ALTER TABLE m365_connections ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE m365_connections ALTER COLUMN profile DROP DEFAULT;
ALTER TABLE m365_connections ALTER COLUMN auth_mode DROP DEFAULT;
ALTER TABLE m365_connections ALTER COLUMN credential_domain DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.breeze_m365_observed_grants_are_canonical(grants JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  is_canonical BOOLEAN;
BEGIN
  IF jsonb_typeof(grants) IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;

  -- Existing legacy rows carry an empty array, which is already canonical.
  IF jsonb_array_length(grants) = 0 THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(grants) AS item(grant_item)
    WHERE jsonb_typeof(grant_item) IS DISTINCT FROM 'object'
       OR NOT (grant_item ?& ARRAY['resourceApplicationId', 'appRoleId', 'value'])
       OR grant_item - ARRAY['resourceApplicationId', 'appRoleId', 'value'] <> '{}'::jsonb
       OR jsonb_typeof(grant_item->'resourceApplicationId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(grant_item->'appRoleId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(grant_item->'value') NOT IN ('string', 'null')
       OR grant_item->>'resourceApplicationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR grant_item->>'appRoleId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT
    COUNT(*) = COUNT(DISTINCT (resource_application_id, app_role_id))
    AND BOOL_AND(source_ordinality = canonical_ordinality)
  INTO is_canonical
  FROM (
    SELECT
      resource_application_id,
      app_role_id,
      source_ordinality,
      ROW_NUMBER() OVER (
        ORDER BY
          resource_application_id COLLATE "C",
          app_role_id COLLATE "C"
      ) AS canonical_ordinality
    FROM (
      SELECT
        grant_item->>'resourceApplicationId' AS resource_application_id,
        grant_item->>'appRoleId' AS app_role_id,
        source_ordinality
      FROM jsonb_array_elements(grants) WITH ORDINALITY
        AS item(grant_item, source_ordinality)
    ) AS parsed
  ) AS normalized;

  RETURN is_canonical;
END;
$$;

-- Refuse to reinterpret or repair existing ownership/security data. Operators
-- must resolve every reported row before retrying; secrets are never rewritten.
DO $$
DECLARE
  invalid_tenants BIGINT;
  invalid_graph_read BIGINT;
  invalid_grants BIGINT;
  duplicate_verified_owners BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_tenants
  FROM m365_connections
  WHERE profile <> 'legacy-direct'
    AND tenant_id IS NOT NULL
    AND tenant_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  SELECT COUNT(*) INTO invalid_graph_read
  FROM m365_connections
  WHERE profile = 'customer-graph-read'
    AND (
      org_id IS NULL
      OR user_id IS NOT NULL
      OR vault_ref IS NULL
      OR credential_version IS NULL
      OR consent_attempt_id IS NULL
    );

  SELECT COUNT(*) INTO invalid_grants
  FROM m365_connections
  WHERE NOT public.breeze_m365_observed_grants_are_canonical(observed_grants);

  SELECT COUNT(*) INTO duplicate_verified_owners
  FROM (
    SELECT tenant_id, profile
    FROM m365_connections
    WHERE tenant_id IS NOT NULL
      AND org_id IS NOT NULL
      AND user_id IS NULL
      AND profile IN (
        'customer-graph-read',
        'customer-graph-actions',
        'customer-exchange-powershell'
      )
    GROUP BY tenant_id, profile
    HAVING COUNT(*) > 1
  ) AS duplicate_groups;

  IF invalid_tenants > 0
     OR invalid_graph_read > 0
     OR invalid_grants > 0
     OR duplicate_verified_owners > 0 THEN
    RAISE EXCEPTION 'm365 consent migration preflight failed: invalid_tenants=%, invalid_graph_read=%, invalid_grants=%, duplicate_verified_owners=%',
      invalid_tenants, invalid_graph_read, invalid_grants, duplicate_verified_owners;
  END IF;
END $$;

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_tenant_guid_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_tenant_guid_check CHECK (
  (profile = 'legacy-direct'
    AND tenant_id IS NOT NULL
    AND tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  OR
  (profile <> 'legacy-direct'
    AND (
      tenant_id IS NULL
      OR tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ))
);

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_observed_grants_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_observed_grants_check
  CHECK (public.breeze_m365_observed_grants_are_canonical(observed_grants));

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_graph_read_consent_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_graph_read_consent_check CHECK (
  profile <> 'customer-graph-read'
  OR (
    org_id IS NOT NULL
    AND user_id IS NULL
    AND vault_ref IS NOT NULL
    AND credential_version IS NOT NULL
    AND consent_attempt_id IS NOT NULL
  )
);

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_profile_binding_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_profile_binding_check CHECK (
  (profile = 'legacy-direct'
    AND org_id IS NOT NULL
    AND auth_mode = 'client-secret-legacy'
    AND credential_domain = 'legacy-direct')
  OR (profile = 'communications-delegated'
    AND user_id IS NOT NULL
    AND auth_mode = 'delegated'
    AND credential_domain = 'communications-delegated')
  OR (profile = 'customer-graph-read'
    AND org_id IS NOT NULL
    AND user_id IS NULL
    AND auth_mode = 'application-certificate'
    AND credential_domain = 'customer-graph-read'
    AND consent_attempt_id IS NOT NULL)
  OR (profile = 'customer-graph-actions'
    AND org_id IS NOT NULL
    AND auth_mode = 'application-certificate'
    AND credential_domain = 'customer-graph-actions')
  OR (profile = 'customer-exchange-powershell'
    AND org_id IS NOT NULL
    AND auth_mode = 'application-certificate'
    AND credential_domain = 'customer-exchange-powershell')
);

ALTER TABLE IF EXISTS m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_connection_identity_fkey;

DROP INDEX IF EXISTS m365_connections_org_uniq;
DROP INDEX IF EXISTS m365_connections_verified_tenant_profile_uniq;
CREATE UNIQUE INDEX m365_connections_verified_tenant_profile_uniq
  ON m365_connections (tenant_id, profile)
  WHERE tenant_id IS NOT NULL
    AND org_id IS NOT NULL
    AND user_id IS NULL
    AND profile IN (
      'customer-graph-read',
      'customer-graph-actions',
      'customer-exchange-powershell'
    );

DROP INDEX IF EXISTS m365_connections_id_org_profile_attempt_uniq;
CREATE UNIQUE INDEX m365_connections_id_org_profile_attempt_uniq
  ON m365_connections (id, org_id, profile, consent_attempt_id);

CREATE TABLE IF NOT EXISTS m365_consent_sessions (
  id UUID CONSTRAINT m365_consent_sessions_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash CHAR(64) NOT NULL,
  phase VARCHAR(24) NOT NULL,
  connection_id UUID NOT NULL,
  org_id UUID NOT NULL,
  profile VARCHAR(64) NOT NULL,
  consent_attempt_id UUID NOT NULL,
  user_id UUID NOT NULL,
  tenant_hint_hash CHAR(64),
  nonce TEXT,
  code_verifier TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_org_id_fkey;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_user_id_fkey;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_profile_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_profile_check
  CHECK (profile = 'customer-graph-read');

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_check CHECK (phase IN ('admin_consent', 'identity_verification'));

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_fields_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_fields_check CHECK (
    (phase = 'admin_consent'
      AND tenant_hint_hash IS NULL
      AND nonce IS NULL
      AND code_verifier IS NULL)
    OR
    (phase = 'identity_verification'
      AND tenant_hint_hash IS NOT NULL
      AND nonce IS NOT NULL
      AND code_verifier IS NOT NULL)
  );

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_connection_identity_fkey;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_connection_identity_fkey
  FOREIGN KEY (connection_id, org_id, profile, consent_attempt_id)
  REFERENCES m365_connections (id, org_id, profile, consent_attempt_id)
  ON DELETE CASCADE;

DROP INDEX IF EXISTS m365_consent_sessions_state_hash_uniq;
CREATE UNIQUE INDEX m365_consent_sessions_state_hash_uniq
  ON m365_consent_sessions (state_hash);
CREATE INDEX IF NOT EXISTS m365_consent_sessions_expires_at_idx
  ON m365_consent_sessions (expires_at);
CREATE INDEX IF NOT EXISTS m365_consent_sessions_connection_attempt_idx
  ON m365_consent_sessions (connection_id, consent_attempt_id);

ALTER TABLE m365_consent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_consent_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_m365_consent_session_select ON m365_consent_sessions;
DROP POLICY IF EXISTS breeze_m365_consent_session_insert ON m365_consent_sessions;
DROP POLICY IF EXISTS breeze_m365_consent_session_update ON m365_consent_sessions;
DROP POLICY IF EXISTS breeze_m365_consent_session_delete ON m365_consent_sessions;

CREATE POLICY breeze_m365_consent_session_select ON m365_consent_sessions
  FOR SELECT USING (public.breeze_current_scope() = 'system');
CREATE POLICY breeze_m365_consent_session_insert ON m365_consent_sessions
  FOR INSERT WITH CHECK (public.breeze_current_scope() = 'system');
CREATE POLICY breeze_m365_consent_session_update ON m365_consent_sessions
  FOR UPDATE USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');
CREATE POLICY breeze_m365_consent_session_delete ON m365_consent_sessions
  FOR DELETE USING (public.breeze_current_scope() = 'system');
