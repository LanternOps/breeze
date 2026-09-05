-- New organizations must participate in daily audit retention immediately.
-- A database trigger covers HTTP/partner provisioning, partner onboarding,
-- AI tools, Quick Support, CSV/accounting imports, seeds and direct SQL alike.
-- Existing organizations (including those without a policy) are untouched.
CREATE OR REPLACE FUNCTION public.breeze_seed_org_audit_retention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Use the table defaults (365 days, no S3 archive). Do not reset an
  -- explicitly configured policy if another creation hook already supplied it.
  INSERT INTO public.audit_retention_policies (org_id)
  VALUES (NEW.id)
  ON CONFLICT (org_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- The caller retains its normal RLS context. Org creation already requires
-- access to NEW.id (production creation paths use a system transaction), and
-- audit_retention_policies uses the same breeze_has_org_access predicate.
DROP TRIGGER IF EXISTS breeze_seed_org_audit_retention ON public.organizations;
CREATE TRIGGER breeze_seed_org_audit_retention
AFTER INSERT ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.breeze_seed_org_audit_retention();

-- A policy is owned by its organization; the newly automatic child must not
-- block deletion of an otherwise empty org (including seed/test cleanup).
ALTER TABLE public.audit_retention_policies
  DROP CONSTRAINT IF EXISTS audit_retention_policies_org_id_organizations_id_fk;
ALTER TABLE public.audit_retention_policies
  ADD CONSTRAINT audit_retention_policies_org_id_organizations_id_fk
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
