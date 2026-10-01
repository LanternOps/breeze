-- Time sync W02 (#7454): one row per device per UTC day of accepted time-status
-- evidence, kept 400 days, plus the per-finding streak counters on
-- device_time_status. Direct org_id tenancy (shape 1) with a DEFERRABLE
-- INITIALLY IMMEDIATE composite (device_id, org_id) FK so org merge/move can
-- re-point both sides. Idempotent; writes no rows.
CREATE TABLE IF NOT EXISTS device_time_daily (
  device_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  worst_health text NOT NULL DEFAULT 'unknown' CHECK (worst_health IN ('healthy','warning','critical','unknown')),
  finding_codes text[] NOT NULL DEFAULT '{}',
  source text,
  source_kind text,
  sync_type text,
  last_successful_sync_at timestamptz,
  snapshot_count integer NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
  expected_timezone text,
  timezone_windows_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, day)
);
CREATE INDEX IF NOT EXISTS device_time_daily_org_day_idx ON device_time_daily(org_id, day);
ALTER TABLE device_time_daily DROP CONSTRAINT IF EXISTS device_time_daily_device_org_fkey;
ALTER TABLE device_time_daily ADD CONSTRAINT device_time_daily_device_org_fkey
  FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE device_time_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_time_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_time_daily;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_time_daily;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_time_daily;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_time_daily;
CREATE POLICY breeze_org_isolation_select ON device_time_daily FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_time_daily FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_time_daily FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_time_daily FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON device_time_daily TO breeze_app;
ALTER TABLE device_time_status ADD COLUMN IF NOT EXISTS finding_streaks jsonb NOT NULL DEFAULT '{}';
