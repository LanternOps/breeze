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

-- SEC-2026-09-05-146 review F3 — keep the authority envelope OUT of the partner
-- export's site material state.
--
-- `breeze_partner_export_site_child_update` (2026-07-23-partner-export-material-
-- state-hardening.sql, still the live definition) touches a site's export
-- watermark whenever a network_baselines column outside its per-table `excluded`
-- list changes. The envelope columns change on every re-arm and every blocked
-- dispatch, none of which alters anything a partner export reconstructs — so
-- without this they would churn export material on a 15-minute cadence.
--
-- Replayed verbatim from that file with only the network_baselines exclusion
-- array extended; `replayMigration` re-applies this file after any replay of the
-- 07-23 original, so the two stay consistent in test databases too.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; org_ids uuid[]; excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id = (to_jsonb(row)->>'site_id')::uuid
        AND s.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'site child tenant owner does not match site'; END IF;
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM (
    SELECT (to_jsonb(row)->>'org_id')::uuid org_id FROM old_rows row
    UNION SELECT (to_jsonb(row)->>'org_id')::uuid FROM new_rows row
  ) owners WHERE org_id IS NOT NULL;
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  excluded := CASE TG_TABLE_NAME
    WHEN 'discovered_assets' THEN ARRAY['is_online', 'approved_by', 'approved_at', 'dismissed_by', 'dismissed_at', 'open_ports', 'os_fingerprint', 'snmp_data', 'response_time_ms', 'last_seen_at', 'last_job_id', 'discovery_methods', 'notes', 'tags', 'updated_at']
    WHEN 'network_baselines' THEN ARRAY['last_scan_at', 'last_scan_job_id', 'known_devices', 'scan_schedule', 'alert_settings', 'updated_at', 'authority_user_id', 'authority_site_ids', 'authority_permissions_epoch', 'authority_mfa_epoch', 'authority_fingerprint', 'authority_generation', 'authority_armed_at', 'schedule_blocked_reason']
    WHEN 'network_topology' THEN ARRAY['bandwidth', 'latency', 'method', 'confidence', 'created_by', 'first_seen_at', 'last_verified_at', 'updated_at']
    ELSE ARRAY[]::text[] END;
  WITH old_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM old_rows row),
  new_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM new_rows row),
  changed AS (
    SELECT o.value old_value, n.value new_value FROM old_data o FULL JOIN new_data n USING (row_key)
    WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded)
      AND (TG_TABLE_NAME <> 'discovered_assets' OR
        (o.value->>'approval_status' = 'approved' AND o.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')) OR
        (n.value->>'approval_status' = 'approved' AND n.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')))
  )
  SELECT array_agg(DISTINCT owner_id ORDER BY owner_id) INTO ids
  FROM changed CROSS JOIN LATERAL (VALUES
    ((old_value->>'site_id')::uuid), ((new_value->>'site_id')::uuid)
  ) owners(owner_id) WHERE owner_id IS NOT NULL;
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
  RETURN NULL;
END;
$$;
