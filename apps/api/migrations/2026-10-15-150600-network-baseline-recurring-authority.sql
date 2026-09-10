-- SEC-2026-09-05-146 — creator-bound versioned authority for recurring
-- network-baseline scans.
--
-- `network_baselines` stored org/site/subnet/scan_schedule but nothing about
-- WHO armed the recurring scan or under what authority, so the scheduler kept
-- dispatching discovery jobs after the arming user was disabled, deleted,
-- removed from the org, moved out of the site or stripped of devices:write.
--
-- This migration adds the durable authority envelope. It is additive and
-- idempotent. Existing enabled schedules carry no envelope and are deliberately
-- NOT backfilled — inventing provenance for them would re-create the finding.
-- They fail closed with schedule_blocked_reason = 'reapproval_required' until an
-- authorized user re-saves the schedule, which arms a fresh envelope.

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_site_ids uuid[];

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_permissions_epoch bigint;

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_mfa_epoch integer;

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_fingerprint text;

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS authority_armed_at timestamptz;

ALTER TABLE network_baselines
  ADD COLUMN IF NOT EXISTS schedule_blocked_reason text;

CREATE INDEX IF NOT EXISTS network_baselines_authority_user_id_idx
  ON network_baselines (authority_user_id);

-- Quarantine legacy enabled schedules so the UI surfaces the re-approval banner
-- immediately rather than only after the first blocked scheduler tick. The
-- runtime dispatch gate fails these rows closed regardless; this write only
-- publishes the reason. network_baselines is FORCE ROW LEVEL SECURITY, which
-- binds the table owner too, so the write must elect system scope first or it
-- silently matches zero rows.
DO $$
DECLARE
  quarantined bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE network_baselines
     SET schedule_blocked_reason = 'reapproval_required'
   WHERE authority_user_id IS NULL
     AND schedule_blocked_reason IS DISTINCT FROM 'reapproval_required'
     AND COALESCE((scan_schedule->>'enabled')::boolean, false) = true;

  GET DIAGNOSTICS quarantined = ROW_COUNT;
  IF quarantined > 0 THEN
    RAISE WARNING 'SEC-146: quarantined % enabled network baseline schedule(s) pending re-approval', quarantined;
  END IF;
END $$;
