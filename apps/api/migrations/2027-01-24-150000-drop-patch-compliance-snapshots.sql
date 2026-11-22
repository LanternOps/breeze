-- High-volume table retention W6.a (#11586 / #11593, OD 9): drop the
-- writer-less patch_compliance_snapshots table instead of pruning it.
--
-- Nothing has ever inserted into this table: no writer exists in apps/,
-- packages/, ee/, scripts or seeds, and none appears in git history (#10396
-- removed the AI fleet tool's read for the same reason). Its last reader, the AI
-- patch agent's optional "latest compliance snapshot" line, is removed in the
-- same PR. The table is de-registered from CORE_ORG_CASCADE_DELETE_ORDER,
-- orgMergeRegistry and CORE_TENANT_EXPORT_POLICY in the same PR.
--
-- ONE-WAY: any rows present are destroyed. The row count is reported first so
-- it lands in the Postgres log (README: cleanup statements report row counts).
-- System scope is elected first: FORCE RLS binds the migration role too, so
-- without it the count would read 0 under the default 'none' scope.
--
-- Nothing references this table (it has no inbound FKs), so a plain DROP TABLE
-- IF EXISTS (no CASCADE) is enough; its own FKs, index, and RLS policies go
-- with it. Idempotent: a re-apply finds no table and does nothing.
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF to_regclass('public.patch_compliance_snapshots') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM public.patch_compliance_snapshots' INTO n;
  IF n > 0 THEN
    RAISE WARNING 'retention W6.a: dropping patch_compliance_snapshots with % row(s)', n;
  END IF;
END $$;

DROP TABLE IF EXISTS public.patch_compliance_snapshots;
