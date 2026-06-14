-- 2026-06-13: device_process_samples — per-device top-N process snapshots for
-- the Performance-tab drill-down. RLS shape #1 (direct org_id), policies created
-- in the same migration that creates the table (CLAUDE.md tenancy rule).
-- timestamp = server receive time (the key for chart correlation);
-- agent_timestamp = agent-reported sample time, kept for clock-skew forensics.

CREATE TABLE IF NOT EXISTS public.device_process_samples (
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  "timestamp" timestamptz NOT NULL,
  agent_timestamp timestamptz,
  top_processes jsonb NOT NULL,
  PRIMARY KEY (device_id, "timestamp")
);

CREATE INDEX IF NOT EXISTS device_process_samples_device_ts_desc_idx
  ON public.device_process_samples (device_id, "timestamp" DESC);

ALTER TABLE public.device_process_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_process_samples FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_process_samples;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_process_samples;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_process_samples;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_process_samples;

CREATE POLICY breeze_org_isolation_select ON public.device_process_samples
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_process_samples
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_process_samples
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_process_samples
  FOR DELETE USING (public.breeze_has_org_access(org_id));
