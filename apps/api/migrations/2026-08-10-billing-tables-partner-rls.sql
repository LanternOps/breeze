-- Partner-axis RLS (shape 3) for the breeze-billing service's tables.
--
-- These tables are created by the separate breeze-billing service, which
-- manages its own schema outside this repo's migrations. The billing service
-- connects as an RLS-exempt role, so forcing RLS here does not affect it;
-- the policies ensure any breeze_app access to these tables is partner-scoped,
-- consistent with every other partner-axis table in this repo.
--
-- Guarded per-table: self-hosted deployments do not run breeze-billing,
-- so the tables may be absent.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_credit_balances',
    'billing_credit_transactions',
    'billing_events',
    'billing_grace_periods',
    'billing_subscriptions'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS breeze_partner_isolation_select ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_partner_isolation_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_partner_isolation_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_partner_isolation_delete ON public.%I', t);

    EXECUTE format(
      'CREATE POLICY breeze_partner_isolation_select ON public.%I
         FOR SELECT USING (public.breeze_has_partner_access(partner_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_partner_isolation_insert ON public.%I
         FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_partner_isolation_update ON public.%I
         FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
         WITH CHECK (public.breeze_has_partner_access(partner_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_partner_isolation_delete ON public.%I
         FOR DELETE USING (public.breeze_has_partner_access(partner_id))', t);
  END LOOP;
END $$;
