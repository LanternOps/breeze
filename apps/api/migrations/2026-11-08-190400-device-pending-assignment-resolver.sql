-- Pre-assignment enrollment — command-delivery eligibility resolver.
--
-- Every path that writes a device command, or pushes one to an agent, asks
-- whether the target device sits in its partner's holding org
-- (organizations.type = 'unassigned_pool'); if so, only lifecycle removal may
-- be sent. The question must be answerable from ANY caller context:
--
--   * A human request context never reaches a holding org (it is kept out of
--     every accessible-org list), so a plain `devices JOIN organizations` read
--     there sees nothing and answers "not parked" — and the enqueue helpers'
--     own system-context wrapper does not escalate inside a request context.
--     The check would fail open exactly where it is least expected to run.
--   * The agent, worker and system contexts can see the row, but the answer
--     must not depend on that.
--
-- So the read is this narrow SECURITY DEFINER resolver. It returns ONE
-- boolean: true iff a device with this id exists and its org is a holding
-- org. It never returns device or org data, and a missing id and a visible
-- non-parked device both answer false.
--
-- EXISTENCE DISCLOSURE — decided, not overlooked. An org-scoped caller can ask
-- about a device id it cannot see and learn "this id is a parked device". That
-- is accepted because:
--   1. the answer is consumed only to REFUSE a command; no caller returns it
--      or branches a response on it before its own device-access check;
--   2. the routes that surface the refusal resolve the device in the caller's
--      own RLS context first and answer 404 for a device they cannot see, so a
--      refusal (409 DEVICE_PENDING_ASSIGNMENT) is only observable for a device
--      the caller could already see — the response for an invisible id is the
--      same 404 whatever this function would say;
--   3. device ids are random UUIDs, so the function cannot enumerate devices;
--      it can only classify an id the caller already holds.
-- A route that enqueued for a client-supplied device id WITHOUT resolving it
-- first would already be a cross-tenant defect independent of this function.
--
-- WHY THE IN-BODY save/elevate/restore of `breeze.scope` (same pattern and
-- reasoning as breeze_command_requester_is_active, 2026-11-05-101500): devices
-- and organizations are FORCE ROW LEVEL SECURITY, which binds the owner too,
-- so SECURITY DEFINER alone is not enough on a deployment whose migration role
-- is not BYPASSRLS; a function-attribute `SET "breeze.scope"` is
-- superuser-only. One RETURN, immediately preceded by the restore; an error
-- rolls the is_local GUC back. The elevated region is one SELECT.
--
-- EXECUTE is revoked from PUBLIC and granted only to breeze_app.
--
-- Idempotent (CREATE OR REPLACE; REVOKE/GRANT are repeatable). Writes no rows,
-- so no migration-level system-scope elevation is needed. No inner BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.breeze_device_is_pending_assignment(
  target_device_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _result boolean := false;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT EXISTS (
    SELECT 1
      FROM public.devices d
      JOIN public.organizations o ON o.id = d.org_id
     WHERE d.id = target_device_id
       AND o.type::text = 'unassigned_pool'
  ) INTO _result;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN COALESCE(_result, false);
END;
$$;

COMMENT ON FUNCTION public.breeze_device_is_pending_assignment(uuid) IS
  'Command-delivery eligibility: true iff the device exists and its org is a holding org (unassigned_pool). Returns only a boolean, answerable from any caller context; callers use it only to refuse a command after resolving the device in their own context. See the migration header for the existence-disclosure decision.';

REVOKE ALL ON FUNCTION public.breeze_device_is_pending_assignment(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_device_is_pending_assignment(uuid) TO breeze_app;
  END IF;
END $$;
