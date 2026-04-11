-- 2026-04-11: Enable RLS on device_metrics using the standard isolation
-- pattern. Column / backfill / FK / index are added by the companion
-- migration 2026-04-11-device-metrics-org-id.sql, which must run first.
--
-- Delete any orphan rows whose device_id no longer exists before we rely
-- on the NOT NULL org_id for the policy — orphans would otherwise be
-- invisible under every org scope and can never be cleaned up through the
-- app.

BEGIN;

DELETE FROM public.device_metrics dm
  WHERE NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = dm.device_id);

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
