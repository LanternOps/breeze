-- Bring the SQL scope allowlist back in step with PARTNER_SERVICE_PRINCIPAL_SCOPES.
--
-- The original migration (2026-07-16-partner-service-principals.sql) enumerated
-- only the eight read scopes. The provisioning write scopes (#3243) and this
-- PR's enrollment-keys:write were both added in TypeScript without a matching
-- SQL change, so the CHECK would reject any principal carrying one of them.
-- This replacement lists every scope in PARTNER_SERVICE_PRINCIPAL_SCOPES.
-- src/services/partnerServicePrincipalScopes.test.ts parses the ARRAY below
-- (from whichever migration most recently replaces this function, in the same
-- localeCompare filename order autoMigrate applies) and asserts exact SET
-- equality with PARTNER_SERVICE_PRINCIPAL_SCOPES. So a scope added in
-- TypeScript alone, or removed from TypeScript but left grantable here, fails
-- the suite rather than surfacing as a CHECK violation in production.

CREATE OR REPLACE FUNCTION public.breeze_valid_partner_service_principal_scopes(
  candidate_scopes text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    candidate_scopes IS NOT NULL
    AND cardinality(candidate_scopes) > 0
    AND cardinality(candidate_scopes) = (
      SELECT count(DISTINCT scope_value)
      FROM unnest(candidate_scopes) AS scope_value
    )
    AND candidate_scopes <@ ARRAY[
      'organizations:read',
      'sites:read',
      'devices:read',
      'inventory:read',
      'configuration:read',
      'scripts:read',
      'backup-configuration:read',
      'custom-fields:read',
      'organizations:write',
      'sites:write',
      'enrollment-keys:write'
    ]::text[];
$$;

-- Safe to add as a validating constraint: until the function above is replaced,
-- the scopes CHECK rejected 'enrollment-keys:write' outright, so no existing row
-- can hold it and the new constraint is trivially satisfied by every row.
ALTER TABLE partner_service_principals
  DROP CONSTRAINT IF EXISTS partner_service_principals_enrollment_key_write_restrictions_check;
ALTER TABLE partner_service_principals
  ADD CONSTRAINT partner_service_principals_enrollment_key_write_restrictions_check
  CHECK (NOT (scopes @> ARRAY['enrollment-keys:write']::text[])
    OR (cardinality(source_cidrs) > 0 AND expires_at IS NOT NULL));

CREATE TABLE IF NOT EXISTS partner_enrollment_key_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  enrollment_key_id uuid REFERENCES enrollment_keys(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_enrollment_key_idempotency_principal_partner_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT partner_enrollment_key_idempotency_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_enrollment_key_idempotency_principal_key_unique
  ON partner_enrollment_key_idempotency(partner_service_principal_id, idempotency_key);

-- The partner-axis FK is otherwise unindexed, which makes the cascade from
-- partners(id) a sequential scan of this table.
CREATE INDEX IF NOT EXISTS partner_enrollment_key_idempotency_partner_idx
  ON partner_enrollment_key_idempotency(partner_id);

-- Retention: claims only need to outlive the window in which a client may
-- retry, not the key itself. This index is the reaper's scan path. The sweep
-- runs inside the existing expired-enrollment-key cleanup job
-- (src/jobs/enrollmentKeyCleanup.ts, daily at 04:00 UTC), which deletes claims
-- older than PARTNER_ENROLLMENT_KEY_IDEMPOTENCY_RETENTION_DAYS in the same
-- system-scoped pass. The FK cascade from enrollment_keys is NOT sufficient on
-- its own: a claim can outlive its key's retention, and a request that died
-- between the claim and the commit leaves a claim with no key at all.
CREATE INDEX IF NOT EXISTS partner_enrollment_key_idempotency_created_at_idx
  ON partner_enrollment_key_idempotency(created_at);

ALTER TABLE partner_enrollment_key_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_enrollment_key_idempotency FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_enrollment_key_idempotency_select ON partner_enrollment_key_idempotency;
DROP POLICY IF EXISTS partner_enrollment_key_idempotency_insert ON partner_enrollment_key_idempotency;
DROP POLICY IF EXISTS partner_enrollment_key_idempotency_update ON partner_enrollment_key_idempotency;
DROP POLICY IF EXISTS partner_enrollment_key_idempotency_delete ON partner_enrollment_key_idempotency;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_enrollment_key_idempotency' AND policyname = 'partner_enrollment_key_idempotency_select') THEN
    CREATE POLICY partner_enrollment_key_idempotency_select ON partner_enrollment_key_idempotency
      FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_enrollment_key_idempotency' AND policyname = 'partner_enrollment_key_idempotency_insert') THEN
    CREATE POLICY partner_enrollment_key_idempotency_insert ON partner_enrollment_key_idempotency
      FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_enrollment_key_idempotency' AND policyname = 'partner_enrollment_key_idempotency_update') THEN
    CREATE POLICY partner_enrollment_key_idempotency_update ON partner_enrollment_key_idempotency
      FOR UPDATE USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_enrollment_key_idempotency' AND policyname = 'partner_enrollment_key_idempotency_delete') THEN
    CREATE POLICY partner_enrollment_key_idempotency_delete ON partner_enrollment_key_idempotency
      FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
