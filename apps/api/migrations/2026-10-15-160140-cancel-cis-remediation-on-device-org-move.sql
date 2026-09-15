-- A pending/queued CIS remediation was admitted for the source organization.
-- Device org moves re-stamp cis_remediation_actions.org_id,
-- so without a pre-cascade fence the later worker cannot distinguish that old
-- authority from a remediation genuinely admitted in the destination org.
--
-- This BEFORE trigger runs after the devices row has been locked by UPDATE and
-- before the AFTER trigger breeze_cascade_device_org_id() re-stamps device
-- children -- which is the whole point of choosing BEFORE. The worker
-- takes locks in the same device -> action order, so exactly one side wins:
-- either the command exists before the move (the separate device_commands
-- lifecycle boundary), or the still-pre-command action becomes terminal here.

CREATE OR REPLACE FUNCTION public.breeze_cancel_cis_remediation_before_device_org_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.org_id IS NOT DISTINCT FROM NEW.org_id THEN
    RETURN NEW;
  END IF;

  -- MERGE FENCE. An org merge is not a device move: orgMergeExecutors repoints
  -- the loser org's devices to the survivor set-based, which fires this trigger
  -- for every device at once. Those remediations were admitted for a tenant
  -- that is being ABSORBED, not left behind -- the admitting authority survives
  -- the merge -- so cancelling them would destroy live work and stamp a reason
  -- ('device_org_changed_before_dispatch') that is simply untrue. Let the row
  -- travel to the survivor via breeze_cascade_device_org_id()'s re-stamp loop
  -- instead. Same fence, and the same reason, as the device_group_memberships
  -- delete and the tickets requester_contact_id detach in
  -- 2026-10-14-100000-ai-operator-thin-slice.sql.
  IF EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    RETURN NEW;
  END IF;

  -- `org_id = OLD.org_id` is LOAD-BEARING, not a redundant narrowing of
  -- `device_id`. Every index on cis_remediation_actions is org_id-leading
  -- (cis_remediation_org_device_status_idx is (org_id, device_id, status)), so
  -- a bare `device_id = ...` predicate has no usable index and degrades to a
  -- sequential scan per row. That is the v0.111.0 US-outage shape: harmless on
  -- a single-device move, a table scan per device on any future set-based
  -- devices.org_id UPDATE. The pre-move org is exactly the org every row this
  -- trigger may cancel is stamped with, because the cascade re-stamp has not
  -- run yet at BEFORE time.
  UPDATE public.cis_remediation_actions
     SET status = 'cancelled',
         details = COALESCE(details, '{}'::jsonb) || jsonb_build_object(
           'cancelledReason', 'device_org_changed_before_dispatch',
           'cancelledAt', clock_timestamp()
         )
   WHERE org_id = OLD.org_id
     AND device_id = OLD.id
     AND status IN ('pending_approval', 'queued');

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_cancel_cis_remediation_before_device_org_move() FROM PUBLIC;

DROP TRIGGER IF EXISTS breeze_cancel_cis_remediation_before_device_org_move ON public.devices;
CREATE TRIGGER breeze_cancel_cis_remediation_before_device_org_move
BEFORE UPDATE OF org_id ON public.devices
FOR EACH ROW
WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
EXECUTE FUNCTION public.breeze_cancel_cis_remediation_before_device_org_move();
