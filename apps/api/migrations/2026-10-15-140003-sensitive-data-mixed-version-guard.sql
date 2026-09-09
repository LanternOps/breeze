-- Fail-closed mixed-version protocol for recurring sensitive-data scans.
-- Deploy this migration before API/workers. Old producers omit the durable
-- generation and old consumers omit it from the endpoint-command payload, so
-- neither can cause scheduled execution during a rolling update.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  invalidated_scan_count bigint;
BEGIN
  UPDATE sensitive_data_scans
  SET status = 'failed',
      completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
      summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
        'dispatch', jsonb_build_object(
          'deniedAt', CURRENT_TIMESTAMP,
          'error', 'legacy_scheduled_authority_invalid'
        )
      )
  WHERE status IN ('queued', 'running')
    AND summary->>'source' = 'policy_scheduler'
    AND policy_authority_generation IS NULL;
  GET DIAGNOSTICS invalidated_scan_count = ROW_COUNT;
  RAISE WARNING 'invalidated % queued or running legacy scheduled sensitive-data scans', invalidated_scan_count;
END $$;

ALTER TABLE sensitive_data_policies
  DROP CONSTRAINT IF EXISTS sensitive_data_policies_recurring_authority_chk;
ALTER TABLE sensitive_data_policies
  ADD CONSTRAINT sensitive_data_policies_recurring_authority_chk CHECK (
    NOT (
      is_active
      AND COALESCE(schedule->>'enabled', 'true') <> 'false'
      AND schedule->>'type' IN ('interval', 'cron')
    )
    OR execution_authority_generation IS NOT NULL
  ) NOT VALID;
ALTER TABLE sensitive_data_policies
  VALIDATE CONSTRAINT sensitive_data_policies_recurring_authority_chk;

CREATE OR REPLACE FUNCTION public.breeze_enforce_scheduled_sensitive_scan_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scan_row sensitive_data_scans%ROWTYPE;
  policy_row sensitive_data_policies%ROWTYPE;
  device_org_id uuid;
  device_site_id uuid;
  device_partner_id uuid;
BEGIN
  IF NEW.type <> 'sensitive_data_scan' THEN RETURN NEW; END IF;
  IF NEW.payload IS NULL OR COALESCE(NEW.payload->>'scanId', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'sensitive-data scan command has invalid scan provenance' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO scan_row FROM sensitive_data_scans
  WHERE id = (NEW.payload->>'scanId')::uuid FOR UPDATE;
  IF NOT FOUND OR scan_row.device_id <> NEW.device_id OR scan_row.status <> 'running' THEN
    RAISE EXCEPTION 'sensitive-data scan command does not match an active scan claim' USING ERRCODE = '23514';
  END IF;
  IF scan_row.policy_authority_generation IS NULL THEN
    IF scan_row.summary->>'source' = 'policy_scheduler' THEN
      RAISE EXCEPTION 'legacy scheduled sensitive-data scan is not authorized' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payload->>'authorityGeneration' IS DISTINCT FROM scan_row.policy_authority_generation::text
      OR scan_row.policy_id IS NULL THEN
    RAISE EXCEPTION 'scheduled sensitive-data scan generation mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO policy_row FROM sensitive_data_policies
  WHERE id = scan_row.policy_id FOR UPDATE;
  IF NOT FOUND OR NOT policy_row.is_active
      OR COALESCE(policy_row.schedule->>'enabled', 'true') = 'false'
      OR policy_row.schedule->>'type' NOT IN ('interval', 'cron')
      OR policy_row.execution_authority_generation IS DISTINCT FROM scan_row.policy_authority_generation THEN
    RAISE EXCEPTION 'scheduled sensitive-data scan approval is no longer current' USING ERRCODE = '23514';
  END IF;

  SELECT d.org_id, d.site_id, o.partner_id
  INTO device_org_id, device_site_id, device_partner_id
  FROM devices d JOIN organizations o ON o.id = d.org_id
  WHERE d.id = NEW.device_id FOR UPDATE OF d;
  IF NOT FOUND OR NOT (
    (policy_row.execution_authority_kind = 'organization_restricted'
      AND policy_row.org_id = device_org_id
      AND device_site_id = ANY(policy_row.execution_authority_site_ids))
    OR (policy_row.execution_authority_kind = 'organization_unrestricted'
      AND policy_row.org_id = device_org_id)
    OR (policy_row.execution_authority_kind = 'partner_unrestricted'
      AND policy_row.partner_id = device_partner_id)
  ) THEN
    RAISE EXCEPTION 'scheduled sensitive-data scan target is no longer authorized' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS breeze_scheduled_sensitive_scan_command_guard ON device_commands;
CREATE TRIGGER breeze_scheduled_sensitive_scan_command_guard
  BEFORE INSERT ON device_commands FOR EACH ROW
  EXECUTE FUNCTION public.breeze_enforce_scheduled_sensitive_scan_command();
