-- #5213 — manual network assets. A hand-entered `discovered_assets` row that
-- inherits full network-device parity. Three pieces of state:
--
--  1. `source` (scan | unifi | manual) — who wrote the row. Backfilled from the
--     UniFi linkage; everything else is a scan. Every writer stamps it from now
--     on, so the column can never silently regress to a default.
--  2. `url` — a website/SaaS endpoint has no stable IP, so the URL is the
--     identity, not a derived attribute.
--  3. `ip_address` becomes NULLable, and the (org_id, ip_address) unique index
--     becomes partial. Two CHECKs hold the line the NOT NULL used to hold:
--     non-manual rows still require an IP, and a manual row must carry at least
--     one of ip / hostname / url. Without the first CHECK a bug in the scan
--     writer would silently produce identity-less rows that the partial index
--     can no longer deduplicate.
--
-- Nothing below USES the new enum values, so ALTER TYPE ... ADD VALUE is safe in
-- this single transaction-wrapped file — same reasoning as
-- 2026-10-11-160000-device-lifecycle-feature-and-decommissioned-at.sql:9-13.

ALTER TYPE public.discovered_asset_type ADD VALUE IF NOT EXISTS 'website';
ALTER TYPE public.discovered_asset_type ADD VALUE IF NOT EXISTS 'service';

DO $$ BEGIN
  CREATE TYPE public.discovered_asset_source AS ENUM ('scan', 'unifi', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.discovered_assets
  ADD COLUMN IF NOT EXISTS source public.discovered_asset_source;
ALTER TABLE public.discovered_assets
  ADD COLUMN IF NOT EXISTS url text;

-- REQUIRED before the first UPDATE: discovered_assets is FORCE ROW LEVEL
-- SECURITY and migrations run as an unprivileged role on managed Postgres,
-- where a context-less UPDATE matches ZERO rows silently. CI's superuser masks
-- this, so the elevation must live here, not be discovered in production.
-- is_local = true scopes it to autoMigrate's per-file transaction, which also
-- wraps both DO blocks below.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.discovered_assets a
     SET source = 'unifi'
   WHERE a.source IS NULL
     AND (a.detected_type_source = 'unifi_controller'
          OR EXISTS (SELECT 1 FROM public.unifi_devices u
                      WHERE u.discovered_asset_id = a.id));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled % discovered_assets rows to source=unifi', n; END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.discovered_assets SET source = 'scan' WHERE source IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled % discovered_assets rows to source=scan', n; END IF;
END $$;

ALTER TABLE public.discovered_assets ALTER COLUMN source SET DEFAULT 'scan';
ALTER TABLE public.discovered_assets ALTER COLUMN source SET NOT NULL;

ALTER TABLE public.discovered_assets ALTER COLUMN ip_address DROP NOT NULL;

-- Index swap. Same NAME so the Drizzle schema stays drift-free; the DROP is
-- guarded on indpred so re-applying is a true no-op rather than a rebuild.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relname = 'discovered_assets_org_ip_unique' AND i.indpred IS NULL) THEN
    DROP INDEX public.discovered_assets_org_ip_unique;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS discovered_assets_org_ip_unique
  ON public.discovered_assets (org_id, ip_address)
  WHERE ip_address IS NOT NULL;

ALTER TABLE public.discovered_assets
  DROP CONSTRAINT IF EXISTS discovered_assets_scan_requires_ip_chk;
ALTER TABLE public.discovered_assets
  ADD CONSTRAINT discovered_assets_scan_requires_ip_chk
  CHECK (source = 'manual' OR ip_address IS NOT NULL);

ALTER TABLE public.discovered_assets
  DROP CONSTRAINT IF EXISTS discovered_assets_manual_identity_chk;
ALTER TABLE public.discovered_assets
  ADD CONSTRAINT discovered_assets_manual_identity_chk
  CHECK (source <> 'manual'
         OR ip_address IS NOT NULL OR hostname IS NOT NULL OR url IS NOT NULL);

COMMENT ON COLUMN public.discovered_assets.source IS
  'Who created the row: scan (discovery worker), unifi (controller sync), manual (operator, #5213).';
COMMENT ON COLUMN public.discovered_assets.url IS
  'Website/SaaS endpoint for asset_type website|service. The identity of an IP-less asset.';
