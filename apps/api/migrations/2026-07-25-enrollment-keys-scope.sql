-- Add enrollment-keys:write to the valid partner service principal scopes.
-- The original migration (2026-07-16-partner-service-principals.sql) did not
-- include this scope; the TypeScript code was updated separately.

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
      'enrollment-keys:write'
    ]::text[];
$$;
