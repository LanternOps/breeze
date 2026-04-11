BEGIN;

-- ============================================================
-- Add org_id to device_metrics for RLS isolation
-- ============================================================

ALTER TABLE public.device_metrics
  ADD COLUMN IF NOT EXISTS org_id uuid;

-- Backfill org_id from the parent devices table
UPDATE public.device_metrics AS dm
SET org_id = d.org_id
FROM public.devices AS d
WHERE dm.device_id = d.id
  AND dm.org_id IS NULL;

-- Enforce NOT NULL after backfill
ALTER TABLE public.device_metrics
  ALTER COLUMN org_id SET NOT NULL;

-- Foreign key to organizations (idempotent)
DO $$ BEGIN
  ALTER TABLE public.device_metrics
    ADD CONSTRAINT device_metrics_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS device_metrics_org_id_timestamp_idx
  ON public.device_metrics (org_id, "timestamp" DESC);

-- ============================================================
-- RLS for device_metrics
-- ============================================================
ALTER TABLE public.device_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_metrics FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_metrics;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_metrics;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_metrics;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_metrics;

CREATE POLICY breeze_org_isolation_select ON public.device_metrics
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_metrics
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_metrics
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_metrics
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
