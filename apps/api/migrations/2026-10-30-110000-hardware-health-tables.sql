DO $$ BEGIN CREATE TYPE hardware_component_type AS ENUM ('controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE hardware_source AS ENUM ('storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE hardware_health AS ENUM ('ok','warning','critical','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE hardware_event_type AS ENUM ('first_seen','health_changed','state_changed','disk_replaced','predictive_failure_set','predictive_failure_cleared','stale','removed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS device_hardware_components (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 component_key text NOT NULL, component_type hardware_component_type NOT NULL, parent_key text, source hardware_source NOT NULL, name text NOT NULL,
 model text, serial text, firmware text, size_bytes bigint, health hardware_health NOT NULL DEFAULT 'unknown', state text NOT NULL, state_detail text,
 progress_percent smallint, temperature_c smallint, predictive_failure boolean NOT NULL DEFAULT false, alert_exempt boolean NOT NULL DEFAULT false, attributes jsonb NOT NULL DEFAULT '{}',
 unhealthy_streak integer NOT NULL DEFAULT 0, critical_streak integer NOT NULL DEFAULT 0, healthy_streak integer NOT NULL DEFAULT 0, below_critical_streak integer NOT NULL DEFAULT 0, predictive_streak integer NOT NULL DEFAULT 0,
 stale boolean NOT NULL DEFAULT false, stale_since timestamptz, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_hardware_components_device_key_uidx ON device_hardware_components(device_id,component_key);
CREATE INDEX IF NOT EXISTS device_hardware_components_device_type_idx ON device_hardware_components(device_id,component_type) WHERE NOT stale;
CREATE INDEX IF NOT EXISTS device_hardware_components_org_health_idx ON device_hardware_components(org_id,health) WHERE NOT stale AND health IN ('warning','critical');
CREATE INDEX IF NOT EXISTS device_hardware_components_stale_idx ON device_hardware_components(stale_since) WHERE stale;
CREATE TABLE IF NOT EXISTS device_hardware_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 component_key text NOT NULL, component_type hardware_component_type NOT NULL, event_type hardware_event_type NOT NULL,
 from_health hardware_health, to_health hardware_health, from_state text, to_state text, detail jsonb NOT NULL DEFAULT '{}', snapshot_id uuid,
 occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_hardware_events_device_occurred_idx ON device_hardware_events(device_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS device_hardware_events_occurred_idx ON device_hardware_events(occurred_at);
CREATE TABLE IF NOT EXISTS device_hardware_health (
 device_id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 health hardware_health NOT NULL DEFAULT 'unknown', collector_health hardware_health NOT NULL DEFAULT 'ok', summary jsonb NOT NULL DEFAULT '{}', sources jsonb NOT NULL DEFAULT '[]',
 last_agent_sequence bigint NOT NULL DEFAULT 0, last_snapshot_id uuid, last_collected_at timestamptz, last_received_at timestamptz,
 last_raid_received_at timestamptz, last_disk_received_at timestamptz, poll_interval_minutes integer, disk_health_interval_minutes integer,
 tiers_run text[] NOT NULL DEFAULT '{}', agent_version text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_hardware_health_org_health_idx ON device_hardware_health(org_id,health);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['device_hardware_components','device_hardware_events','device_hardware_health'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',t,t||'_device_org_fkey');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(device_id,org_id) REFERENCES devices(id,org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE',t,t||'_device_org_fkey');
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_select ON %I FOR SELECT USING (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON %I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_update ON %I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON %I FOR DELETE USING (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON %I TO breeze_app',t);
 END LOOP;
END $$;
