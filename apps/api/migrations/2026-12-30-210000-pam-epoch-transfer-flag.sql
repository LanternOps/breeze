-- PAM ownership epochs W6 (#8208, feature #8202): enablement behind a flag.
-- Spec: docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md
-- §5 (closed predicate), §8 (operations), §10 (rollout), OD4.
--
-- 1. pam_epoch_transfer_config: a one-row switch the request role can never
--    write. The device-move guard's relaxed predicate is gated on it.
--
--    Why not the GUC pair alone (plan Task 6.1): breeze.* placeholders are
--    PGC_USERSET, so any breeze_app session can `set_config(...)` both
--    `breeze.pam_epoch_transfer` and `breeze.ownership_change_cause`; no
--    trigger can tell the route's SET from a forged one. The authority is
--    therefore a table breeze_app holds NO privilege on (REVOKE ALL here and
--    in ensureAppRole.ts after its boot-time blanket GRANT), read through the
--    SECURITY DEFINER breeze_pam_epoch_transfer_enabled(). The GUC pair is
--    still required on top: the route/engine sets it only when its own env
--    flag (PAM_OWNERSHIP_EPOCH_TRANSFER) is on and its own closed check has
--    passed, so turning transfer on needs BOTH the deployment env and this
--    row. Default: row present, enabled = false.
--
--    Turning it on (owner decision, #4060) is a privileged statement run as
--    the table owner / migration role:
--      SELECT set_config('breeze.scope', 'system', false);
--      UPDATE pam_epoch_transfer_config SET enabled = true, updated_at = now();
--
-- 2. breeze_guard_pam_device_org_move() (full body replaced). With the switch
--    on, the GUC pair set and the cause a real ownership change, an org move
--    is refused only while the device's departing-org actuations include one
--    that is NOT pam_actuation_is_closed() (spec §5), as 23514 with constraint
--    devices_pam_open_actuation_move_guard. Otherwise: today's
--    state-blind refusal of any PAM history, unchanged.
--
-- 3. breeze_restamp_unactuated_elevation_requests() (body replaced). An
--    elevation request is source-org history (spec §7.3, §8): on a DEVICE
--    MOVE every request stays at its (org_id, device_epoch) — the move path
--    first expires the pending ones with reason ownership_changed (OD4). The
--    old "un-actuated requests follow the device" restamp could never succeed
--    for a real request anyway: its `requested` elevation_audit row's
--    (elevation_request_id, org_id) FK has no ON UPDATE action and is
--    IMMEDIATE on the move path, so the restamp raised 23503. On an ORG MERGE
--    (cause org_merge; the merge transaction runs SET CONSTRAINTS ALL
--    DEFERRED) un-actuated requests still follow their device into the
--    survivor (§8 merge row) and their elevation_audit rows follow them.
--    Actuated requests never move, in either case.
--
-- 4. PAM evidence retention (spec §7.2, jobs/pamEvidenceRetention.ts): the
--    breeze_audit_admin role gains SELECT/DELETE on the chain tables it does
--    not already hold, plus SELECT on org_evidence_holds. Deletes still
--    require breeze.allow_audit_retention='1' where a table has an
--    append-only trigger (pam_actuation_results).
--
-- Idempotent (CREATE ... IF NOT EXISTS, ON CONFLICT DO NOTHING, CREATE OR
-- REPLACE, DROP POLICY IF EXISTS). No inner BEGIN/COMMIT.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. The switch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pam_epoch_transfer_config (
  singleton  boolean     NOT NULL DEFAULT true,
  enabled    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pam_epoch_transfer_config_pkey PRIMARY KEY (singleton),
  CONSTRAINT pam_epoch_transfer_config_singleton_chk CHECK (singleton)
);

INSERT INTO public.pam_epoch_transfer_config (singleton, enabled)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.pam_epoch_transfer_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pam_epoch_transfer_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_system_only ON public.pam_epoch_transfer_config;
CREATE POLICY breeze_system_only ON public.pam_epoch_transfer_config
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

-- The privilege, not RLS, is the barrier: a breeze_app session can claim
-- system scope, but it cannot touch a table it holds no grant on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON public.pam_epoch_transfer_config FROM breeze_app;
  END IF;
END $$;
REVOKE ALL ON public.pam_epoch_transfer_config FROM PUBLIC;

-- Second barrier: ensureAppRole.ts grants every public table to breeze_app at
-- boot and re-revokes this one in a LATER statement, so for a few
-- milliseconds per boot the privilege alone does not hold (the audit tables
-- with the same gap keep a trigger guard; this one gets its own). A write by
-- any session that logged in as, or has SET ROLE to, breeze_app is refused
-- regardless of grants. session_user is checked too, so a breeze_app session
-- that SET ROLEs to a role it is a member of is still refused.
CREATE OR REPLACE FUNCTION public.breeze_pam_epoch_transfer_config_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user::text = 'breeze_app' OR current_user::text = 'breeze_app' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'pam_epoch_transfer_config is owner-managed; the request role cannot write it';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_pam_epoch_transfer_config_write_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS pam_epoch_transfer_config_write_guard ON public.pam_epoch_transfer_config;
CREATE TRIGGER pam_epoch_transfer_config_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.pam_epoch_transfer_config
  FOR EACH ROW EXECUTE FUNCTION public.breeze_pam_epoch_transfer_config_write_guard();

DROP TRIGGER IF EXISTS pam_epoch_transfer_config_truncate_guard ON public.pam_epoch_transfer_config;
CREATE TRIGGER pam_epoch_transfer_config_truncate_guard
  BEFORE TRUNCATE ON public.pam_epoch_transfer_config
  FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_pam_epoch_transfer_config_write_guard();

-- Definer read. Scope elevated in-body and restored before RETURN (an error
-- aborts the statement, which rolls the set_config back too): the owner is
-- itself subject to the FORCEd system-only policy. A function-level
-- SET "breeze.scope" attribute is not usable (needs superuser in prod;
-- migrationGucAttributes.test.ts). A missing row reads as disabled.
CREATE OR REPLACE FUNCTION public.breeze_pam_epoch_transfer_enabled()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _enabled boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT c.enabled INTO _enabled FROM public.pam_epoch_transfer_config c WHERE c.singleton;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN COALESCE(_enabled, false);
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_pam_epoch_transfer_enabled() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_pam_epoch_transfer_enabled() TO breeze_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Device-move guard (full body; previous: 2026-09-17-pam-device-move-guard.sql)
--
-- Departing-org rows, as before (a device that returned A -> B -> A still
-- has its epoch-1 rows in A; those were closed when it first left, so the
-- org filter and an exact-epoch filter give the same answer). Reads run as
-- the definer under the caller's RLS context, exactly as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_guard_pam_device_org_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN
    RETURN NEW;
  END IF;

  IF current_setting('breeze.pam_epoch_transfer', true) = 'on'
     AND current_setting('breeze.ownership_change_cause', true) IN ('device_move', 'org_merge')
     AND public.breeze_pam_epoch_transfer_enabled() THEN
    IF EXISTS (
      SELECT 1
      FROM public.pam_actuations a
      WHERE a.device_id = OLD.id
        AND a.org_id = OLD.org_id
        AND NOT public.pam_actuation_is_closed(a)
    ) THEN
      -- Its own constraint name so callers map it to PAM_DEVICE_MOVE_ACTIVE
      -- (wait for cleanup) rather than PAM_DEVICE_MOVE_BLOCKED (not enabled).
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'devices_pam_open_actuation_move_guard',
        MESSAGE = 'device organization move blocked by a PAM actuation that is not closed';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pam_actuations
    WHERE device_id = OLD.id
      AND org_id = OLD.org_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'devices_pam_history_move_guard',
      MESSAGE = 'device organization move blocked by durable PAM lifecycle evidence';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Elevation requests on an org change (previous body:
--    2026-12-27-170000-pam-org-move-unactuated-elevation-restamp.sql).
--    Same visibility as before: no scope elevation, the statement sees what
--    the cascade loop saw.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_restamp_unactuated_elevation_requests()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     OR current_setting('breeze.ownership_change_cause', true) IS DISTINCT FROM 'org_merge' THEN
    RETURN NULL;
  END IF;

  WITH moved AS (
    UPDATE public.elevation_requests r
       SET org_id = NEW.org_id
     WHERE r.device_id = NEW.id
       AND r.org_id = OLD.org_id
       AND NOT EXISTS (
             SELECT 1 FROM public.pam_actuations a
              WHERE a.elevation_request_id = r.id
           )
    RETURNING r.id
  )
  UPDATE public.elevation_audit e
     SET org_id = NEW.org_id
    FROM moved
   WHERE e.elevation_request_id = moved.id
     AND e.org_id = OLD.org_id;

  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_restamp_unactuated_elevation_requests() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. PAM evidence retention grants (breeze_audit_admin already holds
--    SELECT, DELETE on pam_actuation_results).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_audit_admin') THEN
    GRANT SELECT, DELETE ON public.pam_actuations TO breeze_audit_admin;
    GRANT SELECT, DELETE ON public.elevation_requests TO breeze_audit_admin;
    GRANT SELECT, DELETE ON public.elevation_audit TO breeze_audit_admin;
    GRANT SELECT ON public.org_evidence_holds TO breeze_audit_admin;
  END IF;
END $$;
