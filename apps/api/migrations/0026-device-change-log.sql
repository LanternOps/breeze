BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'change_type') THEN
    CREATE TYPE change_type AS ENUM (
      'software',
      'service',
      'startup',
      'network',
      'scheduled_task',
      'user_account'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'change_action') THEN
    CREATE TYPE change_action AS ENUM (
      'added',
      'removed',
      'modified',
      'updated'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS device_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  fingerprint varchar(64) NOT NULL,
  timestamp timestamp NOT NULL,
  change_type change_type NOT NULL,
  change_action change_action NOT NULL,
  subject varchar(500) NOT NULL,
  before_value jsonb,
  after_value jsonb,
  details jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_change_log_device_id_idx
  ON device_change_log (device_id);

CREATE INDEX IF NOT EXISTS device_change_log_org_id_idx
  ON device_change_log (org_id);

CREATE INDEX IF NOT EXISTS device_change_log_timestamp_idx
  ON device_change_log (timestamp);

CREATE INDEX IF NOT EXISTS device_change_log_type_idx
  ON device_change_log (change_type);

CREATE INDEX IF NOT EXISTS device_change_log_action_idx
  ON device_change_log (change_action);

CREATE INDEX IF NOT EXISTS device_change_log_device_time_idx
  ON device_change_log (device_id, timestamp);

CREATE INDEX IF NOT EXISTS device_change_log_org_time_idx
  ON device_change_log (org_id, timestamp);

CREATE INDEX IF NOT EXISTS device_change_log_created_at_idx
  ON device_change_log (created_at);

CREATE UNIQUE INDEX IF NOT EXISTS device_change_log_device_fingerprint_uniq
  ON device_change_log (device_id, fingerprint);

ALTER TABLE device_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_change_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_change_log;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_change_log;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_change_log;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_change_log;

CREATE POLICY breeze_org_isolation_select
  ON device_change_log
  FOR SELECT
  USING (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_insert
  ON device_change_log
  FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_update
  ON device_change_log
  FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_delete
  ON device_change_log
  FOR DELETE
  USING (public.breeze_has_org_access(org_id));

COMMIT;
