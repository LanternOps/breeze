-- Partner API alerts:read (read-only alert feed for partner service principals).
--
-- Change tracking for GET /api/v1/partner-api/alerts. The alerts table has no
-- updated_at and ~30 direct write sites, so a BEFORE INSERT OR UPDATE row
-- trigger stamps every write with the writing transaction's 64-bit id
-- (pg_current_xact_id()). Readers bound each traversal by
-- pg_snapshot_xmin(pg_current_snapshot()): every transaction below that
-- horizon has committed or aborted, so a committed write can never appear
-- behind a checkpoint the reader already returned (the commit-order gap a
-- timestamp watermark has). The feed is LATEST-STATE: several transitions of
-- one alert between polls coalesce into its current row.
--
-- Deliberately NOT part of the partner-export per-org advisory-lock protocol:
-- alert writes are hot, and exclusive org locks on hot-table writes are what
-- turned #6671 into the 2026-09-22 outage (see
-- 2026-10-28-100000-partner-export-child-update-lock-on-change.sql).
--
-- Existing rows keep the constant default '1' (a metadata-only ADD COLUMN),
-- which sorts before every real transaction id, so a first full sync covers
-- them. The (partner_feed_xid, id) index is built CONCURRENTLY in the next
-- migration.

ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS partner_feed_xid xid8 NOT NULL DEFAULT '1'::xid8;

CREATE OR REPLACE FUNCTION public.breeze_alerts_stamp_partner_feed_xid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.partner_feed_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_alerts_partner_feed_xid ON public.alerts;
CREATE TRIGGER breeze_alerts_partner_feed_xid
  BEFORE INSERT OR UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.breeze_alerts_stamp_partner_feed_xid();

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
      'organizations:write',
      'sites:write',
      'enrollment-keys:write',
      'contracts:write'
    ]::text[];
$$;
