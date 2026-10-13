-- EDR W03 (#8167 / epic #8164): response-action controls.
--   * edr_connections.actions_enabled — per-connection opt-in (defaults OFF). An
--     MSP must explicitly turn actions on for a vendor console; partner-admin +
--     MFA write (routes/edr/connections.ts). No org_id on this table, so no
--     tenant-export-policy entry.
--   * edr_tenants.unsupported_actions / unsupported_actions_at — the last vendor
--     licence denial per customer company, so the UI renders the action
--     disabled-with-reason and dispatch refuses pre-insert. Expires after 24 h
--     (cleared by the inventory run). Classified `included` in
--     CORE_TENANT_EXPORT_POLICY in the same PR.
--   * In-flight uniqueness on edr_actions: one queued/submitted row per
--     (target, action), so a double click / two techs / AI + human produce one
--     vendor task and one 409.
-- DDL only (the duplicate check below only reads): no breeze.scope preamble.
-- approval_id / ai_session_id deliberately stay FK-less: the ledger row must
-- outlive a pruned action intent / AI session (W03 plan, migration section).

ALTER TABLE edr_connections ADD COLUMN IF NOT EXISTS actions_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE edr_tenants ADD COLUMN IF NOT EXISTS unsupported_actions text[] NOT NULL DEFAULT '{}';
ALTER TABLE edr_tenants ADD COLUMN IF NOT EXISTS unsupported_actions_at timestamptz;

-- W01/W02 never write edr_actions, so no in-flight duplicates can exist. Count
-- them anyway and refuse (instead of deleting evidence) if any are found.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT endpoint_id AS target_id, action FROM edr_actions
     WHERE status IN ('queued', 'submitted') AND endpoint_id IS NOT NULL
     GROUP BY endpoint_id, action HAVING count(*) > 1
    UNION ALL
    SELECT detection_id AS target_id, action FROM edr_actions
     WHERE status IN ('queued', 'submitted') AND detection_id IS NOT NULL
     GROUP BY detection_id, action HAVING count(*) > 1
  ) d;
  RAISE WARNING 'edr_actions in-flight duplicate groups before unique index: %', n;
  IF n > 0 THEN
    RAISE EXCEPTION 'edr_actions has % in-flight duplicate groups; resolve by hand (evidence rows) before re-running', n;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS edr_actions_inflight_endpoint_uniq
  ON edr_actions (endpoint_id, action)
  WHERE status IN ('queued', 'submitted') AND endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS edr_actions_inflight_detection_uniq
  ON edr_actions (detection_id, action)
  WHERE status IN ('queued', 'submitted') AND detection_id IS NOT NULL;

COMMENT ON COLUMN edr_connections.actions_enabled IS 'W03: response actions allowed through this vendor console (opt-in, default off)';
COMMENT ON COLUMN edr_tenants.unsupported_actions IS 'W03: actions the vendor refused for this company (licence); expires after 24h';
