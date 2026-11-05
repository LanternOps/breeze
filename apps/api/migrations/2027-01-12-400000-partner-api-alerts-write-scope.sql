-- Partner API alerts:write (#10528): opt-in scope for acknowledge and resolve
-- (POST /api/v1/partner-api/alerts/:id/acknowledge and /:id/resolve).
--
-- Schema-only: updates the scope allowlist without writing rows. The scope
-- grants neither alerts:read nor suppress, dismiss, delete, bulk or rules.
-- Principal attribution is added by the companion 2027-01-12-400100 migration.
--
-- Keep the SQL scope allowlist exact-set-equal with
-- PARTNER_SERVICE_PRINCIPAL_SCOPES (partnerServicePrincipalScopes.ts).
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
      'alerts:read',
      'tickets:read',
      'device-status:read',
      'organizations:write',
      'sites:write',
      'enrollment-keys:write',
      'contracts:write',
      'tickets:write',
      'alerts:write',
      'ai:read',
      'ai:write',
      'ai:execute',
      'ai:execute_admin'
    ]::text[];
$$;
