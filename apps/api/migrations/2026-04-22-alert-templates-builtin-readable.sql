-- alert_templates: built-in templates have org_id IS NULL, but the existing
-- SELECT policy uses breeze_has_org_access(org_id) which evaluates to NULL
-- (and therefore false) for NULL inputs. That made shared built-in templates
-- invisible to every tenant — caught by configure_defaults silently
-- skipping the standard-alert-policy step with "no built-in alert templates
-- found".
--
-- Widen the SELECT policy so any row with is_built_in = true is visible to
-- everyone, in addition to the existing per-org access check. INSERT/UPDATE/
-- DELETE policies stay strictly org-scoped — tenants must not be able to
-- create or mutate global built-ins.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.alert_templates'::regclass
      AND polname = 'breeze_org_isolation_select'
  ) THEN
    DROP POLICY breeze_org_isolation_select ON public.alert_templates;
  END IF;
END $$;

CREATE POLICY breeze_org_isolation_select ON public.alert_templates
  FOR SELECT
  USING (
    is_built_in = true
    OR public.breeze_has_org_access(org_id)
  );
