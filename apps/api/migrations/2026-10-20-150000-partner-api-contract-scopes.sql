-- Partner API contract-write scope.
--
-- Replaces public.breeze_valid_partner_service_principal_scopes so the SQL
-- allowlist stays exact-set-equal with PARTNER_SERVICE_PRINCIPAL_SCOPES
-- (apps/api/src/services/partnerServicePrincipalScopes.ts). Adding
-- contracts:write in TypeScript alone would let the management API accept a
-- principal the CHECK then rejects.
--
-- src/services/partnerServicePrincipalScopes.test.ts parses the ARRAY below
-- from whichever migration most recently replaces this function.

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
      'enrollment-keys:write',
      'contracts:write'
    ]::text[];
$$;
