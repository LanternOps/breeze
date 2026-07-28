-- Dedupe + unique index for device_vulnerabilities (device_id, vulnerability_id).
--
-- upsertDeviceVulnerability (services/vulnerabilityCorrelation.ts) was a racy
-- SELECT-then-INSERT: two concurrent correlation passes over the same org (or
-- the software + OS passes overlapping) could both miss the SELECT and both
-- INSERT, leaving duplicate findings for one (device, CVE). The service now
-- uses INSERT ... ON CONFLICT (device_id, vulnerability_id) DO UPDATE against
-- the unique index created below; existing duplicates must be removed first or
-- the index build fails.
--
-- device_vulnerabilities is RLS-FORCED (org-axis); elevate to system scope
-- transaction-locally so the cleanup DELETE sees every row even under a
-- non-BYPASSRLS migrator role (precedent: 2026-04-13-fix-uuid-hostnames.sql).
-- autoMigrate wraps the whole file in one transaction, so `is_local => true`
-- scopes the elevation to this migration only.
SELECT set_config('breeze.scope', 'system', true);

-- Keep rule per (device_id, vulnerability_id) group — most-preserving row wins:
--   1. Status rank: accepted > mitigated > open > patched. Human waiver /
--      mitigation state (accepted/mitigated) was set deliberately by a tech and
--      must survive the dedupe. Between the machine-managed states, keeping an
--      OPEN duplicate over a PATCHED one is the conservative choice: if the
--      exposure is truly gone the next correlation resolve pass re-patches the
--      surviving row, whereas dropping the open row could hide live exposure.
--   2. Earliest detected_at — preserves the original first-detection timestamp
--      (the honest exposure-window start) on the surviving row.
--   3. Smallest id — deterministic tiebreak.
-- Cleanup count is RAISEd per CLAUDE.md so the forensic trail survives in the
-- Postgres logs.
DO $$
DECLARE n bigint;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY device_id, vulnerability_id
             ORDER BY
               CASE status
                 WHEN 'accepted'  THEN 0
                 WHEN 'mitigated' THEN 1
                 WHEN 'open'      THEN 2
                 ELSE 3
               END,
               detected_at ASC,
               id ASC
           ) AS rn
      FROM device_vulnerabilities
  )
  DELETE FROM device_vulnerabilities
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % duplicate device_vulnerabilities rows (kept accepted/mitigated/open over patched, then earliest detected_at)', n;
  END IF;
END $$;

-- The upsert target. Org is implied by device (a device belongs to exactly one
-- org), so (device_id, vulnerability_id) is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS device_vuln_device_vulnerability_uniq
  ON device_vulnerabilities (device_id, vulnerability_id);
