-- Drop the legacy organizations.accounting_provider / accounting_external_id
-- pair and its partial unique index (epic #3249, contract phase).
--
-- These two columns were the single-valued linkage key introduced by
-- 2026-06-29-org-accounting-external-id.sql. They were superseded by
-- organization_external_links (2026-08-08), which backfilled a link row for
-- every org carrying both values, and #3298 moved the QuickBooks importer onto
-- the shared org-import seam so nothing writes them any more. The last readers
-- (the seam's union loader in services/orgImport/index.ts, and the legacy
-- constraint name in its concurrent-link recovery) are removed in this same PR,
-- so the columns are now unreferenced.
--
-- Ordering / deployment safety: autoMigrate runs at API boot, before the new
-- code serves traffic, and each droplet runs a single API container — so no old
-- container (whose Drizzle selects still name these columns) ever runs against
-- the migrated database. A future multi-replica or blue/green rollout would
-- need this split into an expand phase (stop reading) and a contract phase
-- (drop) across two releases.
--
-- Idempotent: the backfill is guarded on the columns still existing (so a
-- re-apply after the drop is a no-op rather than a parse error), the insert
-- uses ON CONFLICT DO NOTHING, and both the index drop and the column drops use
-- IF EXISTS.

-- Defensive re-backfill. The 2026-08-08 migration already backfilled, but a
-- deployment that wrote the legacy pair afterwards (an unmigrated code path, a
-- manual UPDATE, or a self-hoster jumping several versions at once) would
-- otherwise lose that linkage silently on the DROP. A nonzero count means
-- exactly that happened and belongs in the Postgres log.
DO $$
DECLARE n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organizations'
      AND column_name = 'accounting_external_id'
  ) THEN
    EXECUTE $backfill$
      INSERT INTO organization_external_links (org_id, partner_id, system, external_id)
      SELECT id, partner_id, accounting_provider, accounting_external_id
      FROM organizations
      WHERE accounting_external_id IS NOT NULL AND accounting_provider IS NOT NULL
      ON CONFLICT DO NOTHING
    $backfill$;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'backfilled % organization_external_links rows before dropping legacy accounting columns', n;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS organizations_accounting_external_uniq;

ALTER TABLE organizations DROP COLUMN IF EXISTS accounting_provider;
ALTER TABLE organizations DROP COLUMN IF EXISTS accounting_external_id;
