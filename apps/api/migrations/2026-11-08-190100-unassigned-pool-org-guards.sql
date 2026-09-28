-- Pre-assignment enrollment — holding-org guards.
--
-- MUST be a separate file from 2026-11-08-170000: that file commits the
-- 'unassigned_pool' label; this one is then free to use it.
--
--   1. exactly one holding org per partner (partial unique index);
--   2. a holding org's identity (type, partner_id, name, slug) never changes,
--      and no org is ever converted INTO a holding org;
--   3. device membership is one-way: an UPDATE never moves a device into a
--      holding org, and an INSERT creates one there only inside a transaction
--      that declared an enrollment admission
--      (set_config('breeze.parked_device_admission', 'enrollment', true)).
--
-- Status / deleted_at transitions are deliberately NOT guarded here — tenant
-- offboarding, archive and erasure flows write them per org and a partner
-- erasure must still be able to remove the holding org; the generic surfaces
-- that could reach them refuse holding orgs in application code.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
-- No inner BEGIN/COMMIT. Writes no rows.

CREATE UNIQUE INDEX IF NOT EXISTS organizations_partner_unassigned_pool_uniq
  ON organizations(partner_id) WHERE type = 'unassigned_pool';

CREATE OR REPLACE FUNCTION public.breeze_guard_unassigned_pool_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.type::text = 'unassigned_pool' THEN
    IF NEW.type IS DISTINCT FROM OLD.type
       OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.slug IS DISTINCT FROM OLD.slug THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'unassigned_pool organizations cannot be renamed, re-typed or moved between partners',
        HINT = 'The holding org is managed by Breeze.';
    END IF;
  ELSIF NEW.type::text = 'unassigned_pool' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'an organization cannot be converted into an unassigned_pool organization',
      HINT = 'Holding orgs are created only by getOrCreateUnassignedPoolOrg.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_guard_unassigned_pool_org() FROM PUBLIC;

DROP TRIGGER IF EXISTS organizations_unassigned_pool_guard ON public.organizations;
CREATE TRIGGER organizations_unassigned_pool_guard
BEFORE UPDATE OF type, partner_id, name, slug ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.breeze_guard_unassigned_pool_org();

-- SECURITY DEFINER + pinned search_path: the org-type lookup must not depend
-- on the caller's RLS context. Same posture as
-- breeze_cancel_cis_remediation_before_device_org_move
-- (2026-10-20-140000-cancel-cis-remediation-on-device-org-move.sql). The
-- integration suite proves it fires for breeze_app in system scope.
CREATE OR REPLACE FUNCTION public.breeze_guard_device_unassigned_pool_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_type text;
BEGIN
  SELECT o.type::text INTO target_type
    FROM public.organizations o
   WHERE o.id = NEW.org_id;

  IF target_type IS DISTINCT FROM 'unassigned_pool' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'devices cannot be moved into an unassigned_pool organization',
      HINT = 'Holding-area membership is one-way: a device enters only through enrollment admission.';
  END IF;

  IF current_setting('breeze.parked_device_admission', true) IS DISTINCT FROM 'enrollment' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'a device can be created in an unassigned_pool organization only by enrollment admission',
      HINT = 'Declare it transaction-locally: set_config(''breeze.parked_device_admission'', ''enrollment'', true).';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_guard_device_unassigned_pool_membership() FROM PUBLIC;

DROP TRIGGER IF EXISTS devices_unassigned_pool_insert_guard ON public.devices;
CREATE TRIGGER devices_unassigned_pool_insert_guard
BEFORE INSERT ON public.devices
FOR EACH ROW
EXECUTE FUNCTION public.breeze_guard_device_unassigned_pool_membership();

DROP TRIGGER IF EXISTS devices_unassigned_pool_move_guard ON public.devices;
CREATE TRIGGER devices_unassigned_pool_move_guard
BEFORE UPDATE OF org_id ON public.devices
FOR EACH ROW
WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
EXECUTE FUNCTION public.breeze_guard_device_unassigned_pool_membership();
