BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'network_event_type'
  ) THEN
    CREATE TYPE public.network_event_type AS ENUM (
      'new_device',
      'device_disappeared',
      'device_changed',
      'rogue_device'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.network_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  subnet varchar(50) NOT NULL,
  last_scan_at timestamp,
  last_scan_job_id uuid REFERENCES public.discovery_jobs(id),
  known_devices jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_schedule jsonb,
  alert_settings jsonb NOT NULL DEFAULT '{"newDevice":true,"disappeared":true,"changed":true,"rogueDevice":false}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT network_baselines_org_site_subnet_unique UNIQUE (org_id, site_id, subnet)
);

CREATE TABLE IF NOT EXISTS public.network_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  baseline_id uuid NOT NULL REFERENCES public.network_baselines(id),
  event_type public.network_event_type NOT NULL,
  ip_address inet NOT NULL,
  mac_address varchar(17),
  hostname varchar(255),
  asset_type public.discovered_asset_type,
  previous_state jsonb,
  current_state jsonb,
  detected_at timestamp NOT NULL DEFAULT now(),
  acknowledged boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES public.users(id),
  acknowledged_at timestamp,
  alert_id uuid REFERENCES public.alerts(id),
  linked_device_id uuid REFERENCES public.devices(id),
  notes text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_baselines_org_id_idx ON public.network_baselines(org_id);
CREATE INDEX IF NOT EXISTS network_baselines_site_id_idx ON public.network_baselines(site_id);

CREATE INDEX IF NOT EXISTS network_change_events_org_id_idx ON public.network_change_events(org_id);
CREATE INDEX IF NOT EXISTS network_change_events_site_id_idx ON public.network_change_events(site_id);
CREATE INDEX IF NOT EXISTS network_change_events_baseline_id_idx ON public.network_change_events(baseline_id);
CREATE INDEX IF NOT EXISTS network_change_events_detected_at_idx ON public.network_change_events(detected_at);
CREATE INDEX IF NOT EXISTS network_change_events_acknowledged_idx ON public.network_change_events(acknowledged);

ALTER TABLE public.network_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_baselines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.network_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.network_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.network_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.network_baselines;
CREATE POLICY breeze_org_isolation_select ON public.network_baselines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.network_baselines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.network_baselines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.network_baselines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.network_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_change_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.network_change_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.network_change_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.network_change_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.network_change_events;
CREATE POLICY breeze_org_isolation_select ON public.network_change_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.network_change_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.network_change_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.network_change_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
