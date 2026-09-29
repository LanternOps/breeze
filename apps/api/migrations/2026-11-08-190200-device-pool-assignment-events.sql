-- Pre-assignment enrollment — assignment ledger.
--
-- Append-only record of every holding-area event: enrolled, assigned,
-- expired, purged. Modelled on org_merge_events
-- (2026-09-12-100001-org-lifecycle-foundations.sql Section 3):
--   * Tenancy shape 3 (partner-axis). Registered in PARTNER_TENANT_TABLES.
--     No org_id column, so NO org cascade / device cascade / org-merge /
--     tenant-export registration: from_org_id / to_org_id are historical
--     snapshots, not tenancy keys.
--   * device_id, from/to org, deploy key and actor are snapshots with NO FK:
--     the record must outlive the device row, the key and the user.
--   * partner_id FK ON DELETE CASCADE: erased with the partner
--     (cascadeDeletePartner's information_schema partner_id sweep also reaches it).
--   * UPDATE blocked by trigger (ensureAppRole re-grants UPDATE on every table,
--     so the trigger is the real guard). DELETE stays granted for the partner
--     erasure sweep.
--
-- Idempotent. No inner BEGIN/COMMIT. Writes no rows.

CREATE TABLE IF NOT EXISTS device_pool_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  device_agent_id varchar(64) NOT NULL,
  event_type text NOT NULL,
  from_org_id uuid,
  to_org_id uuid,
  deploy_key_id uuid,
  deploy_key_name varchar(255),
  assignment_method text,
  assigned_by_user_id uuid,
  step_up_grant_ref text,
  parked_at timestamptz,
  parked_duration_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_pool_assignment_events_event_type_chk
    CHECK (event_type IN ('enrolled', 'assigned', 'expired', 'purged')),
  CONSTRAINT device_pool_assignment_events_method_chk
    CHECK (assignment_method IS NULL OR assignment_method IN ('manual', 'bulk')),
  CONSTRAINT device_pool_assignment_events_duration_chk
    CHECK (parked_duration_seconds IS NULL OR parked_duration_seconds >= 0),
  CONSTRAINT device_pool_assignment_events_shape_chk CHECK (
    (event_type = 'enrolled'
       AND from_org_id IS NULL AND to_org_id IS NOT NULL
       AND assignment_method IS NULL AND parked_duration_seconds IS NULL)
    OR (event_type = 'assigned'
       AND from_org_id IS NOT NULL AND to_org_id IS NOT NULL
       AND assignment_method IS NOT NULL AND assigned_by_user_id IS NOT NULL
       AND parked_duration_seconds IS NOT NULL)
    OR (event_type IN ('expired', 'purged')
       AND from_org_id IS NOT NULL AND to_org_id IS NULL
       AND assignment_method IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS device_pool_assignment_events_partner_created_idx
  ON device_pool_assignment_events (partner_id, created_at);
CREATE INDEX IF NOT EXISTS device_pool_assignment_events_device_idx
  ON device_pool_assignment_events (device_id);
CREATE INDEX IF NOT EXISTS device_pool_assignment_events_deploy_key_idx
  ON device_pool_assignment_events (deploy_key_id);

ALTER TABLE device_pool_assignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_pool_assignment_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_pool_assignment_events_partner_access ON device_pool_assignment_events;
CREATE POLICY device_pool_assignment_events_partner_access ON device_pool_assignment_events
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

GRANT SELECT, INSERT, DELETE ON device_pool_assignment_events TO breeze_app;

CREATE OR REPLACE FUNCTION device_pool_assignment_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'device_pool_assignment_events is append-only',
    HINT = 'Rows cannot be modified once written. DELETE remains allowed for partner erasure.';
END;
$$;

DROP TRIGGER IF EXISTS device_pool_assignment_events_block_update ON device_pool_assignment_events;
CREATE TRIGGER device_pool_assignment_events_block_update BEFORE UPDATE ON device_pool_assignment_events
  FOR EACH ROW EXECUTE FUNCTION device_pool_assignment_events_immutable();
