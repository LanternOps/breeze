-- Partner API ticket scopes (tickets:read / tickets:write).
--
-- Widens the `partner_service_principals.scopes` CHECK allowlist
-- (`breeze_valid_partner_service_principal_scopes`, introduced in
-- 2026-07-16-partner-service-principals.sql and last replaced in
-- 2026-10-30-130000-partner-api-alerts-read.sql) with the two ticketing scopes
-- consumed by the /api/v1/partner-api/tickets surface:
--
--   tickets:read   opt-in read. Ticket subjects/descriptions/comments are
--                  customer-authored data across every org the principal can
--                  reach, so — like alerts:read — it is never part of any
--                  default scope set.
--   tickets:write  create / update / status / assign / comment. No delete,
--                  restore, move-org, bulk, attachments, time entries or
--                  mailbox: those stay human, MFA-gated actions on the main
--                  API, and delete never grows a scope here.
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
      'tickets:write'
    ]::text[];
$$;
