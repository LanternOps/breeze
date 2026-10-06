-- Partner service principal MCP scopes (ai:read / ai:write / ai:execute /
-- ai:execute_admin).
--
-- Widens the `partner_service_principals.scopes` CHECK allowlist
-- (`breeze_valid_partner_service_principal_scopes`, last replaced in
-- 2026-12-04-101000-partner-api-ticket-scopes.sql) with the four MCP transport
-- scopes. A principal holding them can authenticate the MCP endpoint
-- (/api/v1/mcp) with its `brz_sp_` key at PARTNER scope; they grant nothing
-- on /api/v1/partner-api. All four are opt-in and never part of a default
-- scope set. Per-tool RBAC, the Tier 3 approval gate, rate limits, the Tier 3
-- execution ledger and the audit log still apply over MCP.
--
-- The TypeScript list in services/partnerServicePrincipalScopes.ts must match
-- this ARRAY exactly; partnerServicePrincipalScopes.test.ts asserts parity
-- against whichever migration most recently defines the function.
--
-- CREATE OR REPLACE is idempotent; nothing here writes rows.

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
      'organizations:write',
      'sites:write',
      'enrollment-keys:write',
      'contracts:write',
      'tickets:write',
      'ai:read',
      'ai:write',
      'ai:execute',
      'ai:execute_admin'
    ]::text[];
$$;
