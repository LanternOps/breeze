-- #4247 step 2/4: backfill report_runs.org_id / partner_id from the parent.
--
-- Ownership is copied from the parent report's CURRENT owner. For a run whose
-- parent was re-homed by an org merge, that is the survivor org — not the org
-- the run executed under. Execution fingerprints (execution_scope_fingerprint)
-- bind the owner they were captured for and are NOT regenerated here: a run
-- whose fingerprint was captured for a different owner already fails
-- decodeSiteScope today and keeps failing closed. This file does not claim to
-- recover historical ownership.
--
-- Concurrency: both tables are locked SHARE ROW EXCLUSIVE for the duration
-- (reads continue; report owner changes and run inserts wait) so no owner can
-- move between the copy and the audit. Lock order is report_runs THEN reports,
-- the order the scheduler takes them (insert the run, then stamp the report),
-- so the two cannot deadlock. Run inserts arriving after commit are filled by
-- report_runs_fill_owner (160000).
--
-- Batched by ctid (CLAUDE.md hot-table rule). The batches bound per-statement
-- work only: autoMigrate runs this file in one transaction, so the locks are
-- held until the whole backfill commits. Idempotent: only rows with neither
-- owner column are touched.

SELECT set_config('breeze.scope', 'system', true);

LOCK TABLE report_runs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE reports IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  n integer;
  total bigint := 0;
  remaining bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  LOOP
    UPDATE report_runs rr
       SET org_id = r.org_id,
           partner_id = r.partner_id
      FROM reports r
     WHERE rr.ctid IN (
             SELECT ctid FROM report_runs
              WHERE org_id IS NULL AND partner_id IS NULL
              LIMIT 5000
           )
       AND r.id = rr.report_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXIT WHEN n = 0;
  END LOOP;

  IF total > 0 THEN
    RAISE WARNING '#4247 backfilled owner on % report_runs rows from their parent report', total;
  ELSE
    RAISE NOTICE '#4247 backfilled owner on 0 report_runs rows';
  END IF;

  SELECT count(*) INTO remaining FROM report_runs WHERE org_id IS NULL AND partner_id IS NULL;
  IF remaining > 0 THEN
    -- Not expected (report_id is NOT NULL with an FK, and reports_one_owner_chk
    -- holds). If it happens, 160200's VALIDATE aborts the deploy with the rows
    -- left in place for inspection.
    RAISE WARNING '#4247 % report_runs rows still have no owner after backfill', remaining;
  END IF;
END $$;

-- Audit only (no writes): runs whose execution-scope kind belongs to the OTHER
-- owner axis than the parent they now hang off. Such a run's envelope cannot
-- decode under its current owner (decodeSiteScope refuses partner_wide on an
-- org owner and an org kind on a partner owner). Counted for the forensic
-- trail; deliberately left untouched.
DO $$
DECLARE
  partner_kind_on_org bigint;
  org_kind_on_partner bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT count(*) INTO partner_kind_on_org
    FROM report_runs WHERE execution_scope_kind = 'partner_wide' AND org_id IS NOT NULL;
  SELECT count(*) INTO org_kind_on_partner
    FROM report_runs
   WHERE execution_scope_kind IN ('restricted', 'unrestricted', 'legacy_unscoped')
     AND partner_id IS NOT NULL;
  IF partner_kind_on_org > 0 OR org_kind_on_partner > 0 THEN
    RAISE WARNING '#4247 owner-axis mismatch: % partner_wide runs under an org-owned report, % org-kind runs under a partner-owned report (left as-is; they fail decode closed)',
      partner_kind_on_org, org_kind_on_partner;
  ELSE
    RAISE NOTICE '#4247 owner-axis mismatch audit: 0 rows';
  END IF;
END $$;
