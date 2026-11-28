-- #12825 one-off data step: clear GravityZone endpoint last-seen times stored before the UTC fix.
--
-- Why: GravityZone sends offset-less times in the API key owner's account timezone. Before #12821
-- they were stored as if they were UTC, so a stored `last_seen_at` is off by that owner's UTC
-- offset. Until now each inventory list upsert nulled the column and only the endpoints whose
-- details were read in that run (at most 50 per company) held a value, so a wrong value lasted one
-- run. #12825 makes `last_seen_at` detail-owned: it is kept between detail reads. Without this step
-- the rows read in the last run before the deploy would keep the wrong time until their next
-- detail read. Those rows are the most recently read, so they come last in the stalest-first
-- rotation: up to ceil(N / 50) - 1 more runs for a company of N endpoints.
--
-- What: for provider 'bitdefender' rows that hold a time, set `last_seen_at` and
-- `vendor_detail_synced_at` to NULL. A stored value carries no mark of the build that wrote it, so
-- a correct time written by a build that has #12821 but not this change is cleared too; that costs
-- one inventory interval of an unknown time for those endpoints. Detail enrichment reads newly
-- listed endpoints first, then stored ones by `vendor_detail_synced_at ASC NULLS FIRST`, 50 per
-- company per run, so the cleared rows are read in the next run, alongside any endpoint never read
-- before, and their time is stored in UTC. Until then they show an unknown last-seen time, never a
-- wrong one.
-- `health`, `online` and `agent_version` stay: they come from vendor flags, `state` and the agent
-- version, not from a time, so the timezone misread never touched them.
--
-- Size and locks: at most 50 rows per GravityZone company hold a time (see above). The scan is one
-- pass over `edr_endpoints` (one row per endpoint of a mapped company), with row locks only on the
-- matched rows, released when this file's transaction commits. No batching is needed. The table
-- carries no partner-export triggers, so no pre-locks are needed.
--
-- Re-application: autoMigrate records this file in `breeze_migrations` in the same transaction,
-- after the file runs, so on its one real application the file finds no ledger row of its own and
-- runs. A replay outside the runner (a manual `psql -f`, an integration replay) then finds that row
-- and does nothing, so it cannot clear times stored correctly after the deploy. Same guard shape as
-- 2026-10-06-100101-authenticator-attestation-state.sql.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.edr_endpoints') IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.breeze_migrations') IS NOT NULL AND EXISTS (
    SELECT 1 FROM breeze_migrations
     WHERE filename = '2027-02-01-100000-gravityzone-clear-pre-utc-last-seen.sql'
  ) THEN
    RAISE NOTICE '#12825: already applied, GravityZone last_seen_at left as stored';
    RETURN;
  END IF;

  UPDATE edr_endpoints
     SET last_seen_at = NULL,
         vendor_detail_synced_at = NULL,
         updated_at = now()
   WHERE provider = 'bitdefender'
     AND last_seen_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#12825: cleared % GravityZone endpoint last_seen_at value(s), some possibly misread before the UTC fix; the next inventory run re-reads them', n;
  END IF;
END $$;
