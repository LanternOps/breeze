BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'peripheral_device_class') THEN
    CREATE TYPE peripheral_device_class AS ENUM ('storage', 'all_usb', 'bluetooth', 'thunderbolt');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'peripheral_policy_action') THEN
    CREATE TYPE peripheral_policy_action AS ENUM ('allow', 'block', 'read_only', 'alert');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'peripheral_policy_target_type') THEN
    CREATE TYPE peripheral_policy_target_type AS ENUM ('organization', 'site', 'group', 'device');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'peripheral_event_type') THEN
    CREATE TYPE peripheral_event_type AS ENUM ('connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS peripheral_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(200) NOT NULL,
  device_class peripheral_device_class NOT NULL,
  action peripheral_policy_action NOT NULL,
  target_type peripheral_policy_target_type NOT NULL,
  target_ids jsonb DEFAULT '{}'::jsonb,
  exceptions jsonb DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS peripheral_policy_org_active_idx
  ON peripheral_policies (org_id, is_active);
CREATE INDEX IF NOT EXISTS peripheral_policy_org_class_idx
  ON peripheral_policies (org_id, device_class);

CREATE TABLE IF NOT EXISTS peripheral_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  policy_id uuid REFERENCES peripheral_policies(id),
  source_event_id varchar(255),
  event_type peripheral_event_type NOT NULL,
  peripheral_type varchar(40) NOT NULL,
  vendor varchar(255),
  product varchar(255),
  serial_number varchar(255),
  details jsonb,
  occurred_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE peripheral_events
  ADD COLUMN IF NOT EXISTS source_event_id varchar(255);

CREATE INDEX IF NOT EXISTS peripheral_events_org_device_time_idx
  ON peripheral_events (org_id, device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS peripheral_events_type_idx
  ON peripheral_events (event_type);
CREATE INDEX IF NOT EXISTS peripheral_events_org_policy_time_idx
  ON peripheral_events (org_id, policy_id, occurred_at DESC);
DROP INDEX IF EXISTS peripheral_events_source_event_idx;
DROP INDEX IF EXISTS peripheral_events_source_evt_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS peripheral_events_source_event_idx
  ON peripheral_events (org_id, device_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS peripheral_events_type_time_idx
  ON peripheral_events (event_type, occurred_at DESC);

ALTER TABLE peripheral_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE peripheral_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON peripheral_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON peripheral_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON peripheral_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON peripheral_policies;
CREATE POLICY breeze_org_isolation_select ON peripheral_policies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON peripheral_policies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON peripheral_policies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON peripheral_policies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE peripheral_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE peripheral_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON peripheral_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON peripheral_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON peripheral_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON peripheral_events;
CREATE POLICY breeze_org_isolation_select ON peripheral_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON peripheral_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON peripheral_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON peripheral_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
