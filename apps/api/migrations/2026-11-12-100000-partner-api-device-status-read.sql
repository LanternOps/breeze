-- Partner API device-status:read (#7577): opt-in scope for the live device
-- status feed (GET /api/v1/partner-api/device-status).
--
-- Schema-only: the feed reads devices.status / last_seen_at / agent_version at
-- request time. It adds no columns, triggers or partner-export watermark
-- state — liveness is deliberately kept out of the material-change export
-- and its per-org advisory locks (see #6698).
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
      'device-status:read',
      'organizations:write',
      'sites:write',
      'enrollment-keys:write',
      'contracts:write'
    ]::text[];
$$;
