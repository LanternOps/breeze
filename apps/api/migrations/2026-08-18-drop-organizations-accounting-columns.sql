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
-- Idempotent: the backfill is guarded on BOTH columns still existing (so a
-- re-apply after the drop is a no-op rather than a missing-column abort), the
-- insert uses an explicitly targeted ON CONFLICT DO NOTHING, and both the index
-- drop and the column drops use IF EXISTS.

-- Defensive re-backfill. The 2026-08-08 migration already backfilled, but a
-- deployment that wrote the legacy pair afterwards (an unmigrated code path, a
-- manual UPDATE, or a self-hoster jumping several versions at once) would
-- otherwise lose that linkage silently on the DROP.
--
-- Every row that CANNOT be carried over is counted and logged rather than
-- silently discarded (CLAUDE.md's forensic-trail rule). There are two such
-- classes, and both are real linkage loss a tech may have to reconcile by hand:
--
--   * conflicting  — (partner_id, system, external_id) is already linked to a
--     DIFFERENT organization, so ON CONFLICT drops our row. Left unreported this
--     is the nastiest outcome: the surviving org keeps the link, the losing org
--     ends up with no linkage at all, and the next QuickBooks import sees it as
--     unlinked — so the seam offers "confirm this match" and collapses two
--     QuickBooks customers onto one tenant, which is exactly what
--     matchedOrganizationLinkedToSystem (#3298) exists to prevent.
--   * providerless — accounting_external_id set with a NULL accounting_provider.
--     The 2026-06-29 partial unique index was `WHERE accounting_external_id IS
--     NOT NULL`, so these rows are legal and have been storable all along. They
--     cannot be migrated because organization_external_links.system is NOT NULL.
--
-- The guard requires BOTH columns, not just one: the body names both, and on a
-- half-dropped schema a single-column guard would pass and then fail with
-- `column "accounting_provider" does not exist`, aborting autoMigrate at boot so
-- the API never starts. plpgsql resolves column names lazily (only when the
-- branch is actually taken), so the plain INSERT below is replay-safe once the
-- columns are gone — no EXECUTE wrapper needed, and inlining keeps the
-- statement under parse-time checking.
DO $$
DECLARE
  inserted     integer;
  conflicting  integer;
  providerless integer;
BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organizations'
      AND column_name IN ('accounting_provider', 'accounting_external_id')
  ) = 2 THEN
    INSERT INTO organization_external_links (org_id, partner_id, system, external_id)
    SELECT id, partner_id, accounting_provider, accounting_external_id
    FROM organizations
    WHERE accounting_external_id IS NOT NULL AND accounting_provider IS NOT NULL
    ON CONFLICT (partner_id, system, external_id) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;

    IF inserted > 0 THEN
      RAISE WARNING 'backfilled % organization_external_links rows before dropping legacy accounting columns', inserted;
    END IF;

    -- Only rows whose surviving link belongs to ANOTHER org are losses. Rows
    -- already linked to the SAME org are the ordinary idempotent case (the
    -- 2026-08-08 backfill) and must not be reported as such.
    SELECT count(*) INTO conflicting
    FROM organizations o
    JOIN organization_external_links l
      ON l.partner_id  = o.partner_id
     AND l.system      = o.accounting_provider
     AND l.external_id = o.accounting_external_id
    WHERE o.accounting_external_id IS NOT NULL
      AND o.accounting_provider IS NOT NULL
      AND l.org_id <> o.id;
    IF conflicting > 0 THEN
      RAISE WARNING 'DISCARDED % legacy accounting linkage row(s): (partner_id, system, external_id) is already linked to a DIFFERENT organization; those organizations are now unlinked and must be reconciled by hand', conflicting;
    END IF;

    SELECT count(*) INTO providerless
    FROM organizations
    WHERE accounting_external_id IS NOT NULL AND accounting_provider IS NULL;
    IF providerless > 0 THEN
      RAISE WARNING 'DISCARDED % legacy accounting_external_id value(s) with a NULL accounting_provider: organization_external_links.system is NOT NULL, so there is no system to migrate them under', providerless;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS organizations_accounting_external_uniq;

ALTER TABLE organizations DROP COLUMN IF EXISTS accounting_provider;
ALTER TABLE organizations DROP COLUMN IF EXISTS accounting_external_id;
