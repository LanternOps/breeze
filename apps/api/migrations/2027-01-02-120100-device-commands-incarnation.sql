-- #8318 wave 1a — the install incarnation boundary
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.2). Part 2 of 3: `device_commands` only.
--
-- Every device_commands row is stamped with the devices.install_incarnation it
-- was enqueued for (part 1 added the column), so claim and result acceptance
-- can refuse work and results of an earlier install.
--
--   device_incarnation      integer, NULL on rows written before this file
--                           (a NULL stamp counts as incarnation 1, §4.1)
--   device_commands_stamp_incarnation: BEFORE INSERT, SECURITY DEFINER, stamps
--     every new row from devices.install_incarnation read FOR KEY SHARE (the
--     lock the FK check already takes), so an inserter whose context cannot
--     see the device row still stamps the right value. A missing device raises
--     23503 (the FK's own code) instead of stamping NULL. The caller's value is
--     always overwritten.
--   breeze_device_command_incarnation_is_current(command_id): the refusal
--     predicate claim and result acceptance share.
--   device_commands_incarnation_guard: the stamp is immutable once written.
--
-- One hot table per transaction: this file locks `device_commands` and no
-- other table (the functions read `devices` only when they run).
--
-- Tenancy: device_commands stays system-scoped (no org_id; the new column is
-- not named org_id, so the RLS and cascade auto-discovery still skip it, and it
-- needs no export classification).
--
-- No row is written, so no system-scope election is needed. Same lock_timeout
-- discipline as part 1.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.device_commands ADD COLUMN IF NOT EXISTS device_incarnation integer;

-- Reads past RLS: `devices` is FORCE ROW LEVEL SECURITY, which binds the
-- definer too, so the function elects system scope for its one read and
-- restores the caller's scope before returning (the
-- breeze_command_requester_is_active pattern, 2026-11-05-101500).
--
-- The race with a reattach confirm (§4.2): confirm holds the device row
-- FOR UPDATE, which conflicts with this FOR KEY SHARE. An insert that read
-- first stamps n and is committed before confirm proceeds, so the boundary
-- cancels it with the other open rows. An insert that waits behind confirm
-- reads the committed row afterwards (READ COMMITTED) and stamps n+1: the
-- command reaches the new install, as one enqueued just after confirm would.
CREATE OR REPLACE FUNCTION public.breeze_stamp_device_command_incarnation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _incarnation integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT d.install_incarnation
    INTO _incarnation
    FROM public.devices d
   WHERE d.id = NEW.device_id
     FOR KEY SHARE;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);

  IF _incarnation IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('device_commands.device_id %s does not name a device', NEW.device_id);
  END IF;

  NEW.device_incarnation := _incarnation;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.breeze_stamp_device_command_incarnation() IS
  '#8318 §4.2: stamps device_commands.device_incarnation from devices.install_incarnation (FOR KEY SHARE) on every insert, past RLS. Claim and result acceptance refuse a row whose stamp (NULL = 1) differs from the device''s current incarnation.';

REVOKE ALL ON FUNCTION public.breeze_stamp_device_command_incarnation() FROM PUBLIC;

DROP TRIGGER IF EXISTS device_commands_stamp_incarnation ON public.device_commands;
CREATE TRIGGER device_commands_stamp_incarnation
  BEFORE INSERT ON public.device_commands
  FOR EACH ROW EXECUTE FUNCTION public.breeze_stamp_device_command_incarnation();

-- The refusal predicate claim and result acceptance share
-- (services/commandResultAcceptance.ts commandIncarnationIsCurrentCondition):
-- is this command's stamp (NULL = 1) the device's CURRENT incarnation? Read
-- in the calling statement, past RLS, because the result paths read
-- device_commands contextless (it is RLS-free) and a `devices` subquery there
-- would see no row. Keyed by the command id, so it answers only about a row
-- the caller can already read; an unknown command or device answers false.
-- VOLATILE like the other scope-electing resolvers: each call reads the
-- newest committed device row.
CREATE OR REPLACE FUNCTION public.breeze_device_command_incarnation_is_current(p_command_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _current boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT COALESCE(c.device_incarnation, 1) = d.install_incarnation
    INTO _current
    FROM public.device_commands c
    JOIN public.devices d ON d.id = c.device_id
   WHERE c.id = p_command_id;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN COALESCE(_current, false);
END;
$$;

COMMENT ON FUNCTION public.breeze_device_command_incarnation_is_current(uuid) IS
  '#8318 §4.2/§5.2: true iff the command''s device_incarnation (NULL = 1) equals its device''s current install_incarnation. Claim and result acceptance refuse a row for which this is false.';

REVOKE ALL ON FUNCTION public.breeze_device_command_incarnation_is_current(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_device_command_incarnation_is_current(uuid) TO breeze_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_device_commands_incarnation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.device_incarnation IS DISTINCT FROM OLD.device_incarnation THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'device_commands.device_incarnation is stamped at insert and never rewritten';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS device_commands_incarnation_guard ON public.device_commands;
CREATE TRIGGER device_commands_incarnation_guard
  BEFORE UPDATE OF device_incarnation ON public.device_commands
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_commands_incarnation_guard();
