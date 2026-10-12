-- PAM ownership epochs W2 (#8204, feature #8202): anchor the PAM chain to the
-- device's ownership epoch instead of the live devices row.
--
-- Spec: docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md
-- §4.3 (anchoring), §4.4 (exact-epoch deletion), §5 (closed predicate), §9
-- (lock order). Builds on 2026-12-17-130000-device-ownership-epochs.sql (W1).
--
-- 1. elevation_requests, pam_actuations and pam_actuation_results gain
--    device_epoch integer NOT NULL. ADD COLUMN with a constant DEFAULT is a
--    catalog-only change: no tuple is rewritten and no row trigger fires, so
--    the append-only pam_actuation_results stays byte-identical (its revoke
--    and pam_actuation_results_block_mutation are untouched).
-- 2. The FKs onto the live device are replaced by FKs onto the epoch row:
--      elevation_requests    (device_id, org_id, device_epoch)
--                              -> device_ownership_epochs (device_id, org_id, epoch)
--      pam_actuations        (device_id, org_id, device_epoch)
--                              -> device_ownership_epochs ON DELETE CASCADE
--      pam_actuation_results (actuation_id, device_id, org_id, device_epoch)
--                              -> pam_actuations (id, device_id, org_id, device_epoch) ON DELETE CASCADE
--    All DEFERRABLE INITIALLY IMMEDIATE (org merge defers constraints). The
--    existing (actuation_id, org_id) and (elevation_request_id, org_id) FKs
--    are kept unchanged.
-- 3. Rows written after a W1 epoch advance (device moved with no PAM history,
--    then gained a chain) carry the column default 1, which names the wrong
--    org's epoch. elevation_requests and pam_actuations are re-anchored to the
--    epoch of their own org that was current when they were created. Results
--    are never updated; if one ends up under a re-anchored actuation its FK is
--    left NOT VALID (still enforced for new rows) with a WARNING, rather than
--    failing the boot.
-- 4. Guards (breeze_pam_chain_epoch_guard): an INSERT must be in the device's
--    current org and epoch (23514), read FOR SHARE so it serializes against an
--    org change; an omitted device_epoch is anchored to the current epoch. On
--    UPDATE the (device_id, org_id, device_epoch) tuple of an actuated chain is
--    immutable (42501). An elevation request that never reached actuation is
--    not evidence (spec §1, §8): when its org changes with its device (device
--    move restamp, merge repoint) it is re-anchored to the device's current
--    epoch, preserving today's move/merge behaviour.
-- 5. public.pam_actuation_is_closed(pam_actuations) and a terminal `cleaned`
--    state in pam_actuations_transition_guard.
--
-- Idempotent: the guard triggers are dropped first and re-created last, the
-- FKs are dropped and re-added, and the backfill only touches rows whose
-- anchor differs from the computed one.

SELECT set_config('breeze.scope', 'system', true);

DROP TRIGGER IF EXISTS elevation_requests_epoch_guard ON public.elevation_requests;
DROP TRIGGER IF EXISTS pam_actuations_epoch_guard ON public.pam_actuations;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.elevation_requests    ADD COLUMN IF NOT EXISTS device_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE public.pam_actuations        ADD COLUMN IF NOT EXISTS device_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE public.pam_actuation_results ADD COLUMN IF NOT EXISTS device_epoch integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 2a. Drop the live-device FKs (and the new ones, for replay). Results first:
--     its new FK depends on the pam_actuations unique key re-created below.
-- ---------------------------------------------------------------------------
ALTER TABLE public.pam_actuation_results DROP CONSTRAINT IF EXISTS pam_actuation_results_device_id_org_id_fkey;
ALTER TABLE public.pam_actuation_results DROP CONSTRAINT IF EXISTS pam_actuation_results_actuation_epoch_fkey;
ALTER TABLE public.pam_actuations        DROP CONSTRAINT IF EXISTS pam_actuations_device_id_org_id_fkey;
ALTER TABLE public.pam_actuations        DROP CONSTRAINT IF EXISTS pam_actuations_device_epoch_fkey;
ALTER TABLE public.elevation_requests    DROP CONSTRAINT IF EXISTS elevation_requests_device_id_fkey;
ALTER TABLE public.elevation_requests    DROP CONSTRAINT IF EXISTS elevation_requests_device_epoch_fkey;

-- ---------------------------------------------------------------------------
-- 3. Backfill. The anchor of a row is the latest epoch of the row's own
--    (device, org) that had started when the row was created; rows older than
--    every such epoch (the W1 backfill stamped epoch 1 at migration time) take
--    the earliest one. Rows whose (device, org) has no epoch at all are left
--    alone and reported by the validation step.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_requests integer;
  n_actuations integer;
BEGIN
  WITH anchor AS (
    SELECT r.id,
           COALESCE(
             (SELECT max(e.epoch) FROM public.device_ownership_epochs e
               WHERE e.device_id = r.device_id AND e.org_id = r.org_id AND e.started_at <= r.created_at),
             (SELECT min(e.epoch) FROM public.device_ownership_epochs e
               WHERE e.device_id = r.device_id AND e.org_id = r.org_id)
           ) AS epoch
    FROM public.elevation_requests r
  )
  UPDATE public.elevation_requests r
     SET device_epoch = anchor.epoch
    FROM anchor
   WHERE anchor.id = r.id
     AND anchor.epoch IS NOT NULL
     AND anchor.epoch <> r.device_epoch;
  GET DIAGNOSTICS n_requests = ROW_COUNT;

  WITH anchor AS (
    SELECT a.id,
           COALESCE(
             (SELECT max(e.epoch) FROM public.device_ownership_epochs e
               WHERE e.device_id = a.device_id AND e.org_id = a.org_id AND e.started_at <= a.created_at),
             (SELECT min(e.epoch) FROM public.device_ownership_epochs e
               WHERE e.device_id = a.device_id AND e.org_id = a.org_id)
           ) AS epoch
    FROM public.pam_actuations a
  )
  UPDATE public.pam_actuations a
     SET device_epoch = anchor.epoch
    FROM anchor
   WHERE anchor.id = a.id
     AND anchor.epoch IS NOT NULL
     AND anchor.epoch <> a.device_epoch;
  GET DIAGNOSTICS n_actuations = ROW_COUNT;

  IF n_requests > 0 OR n_actuations > 0 THEN
    RAISE WARNING 'pam chain epoch anchor: re-anchored % elevation_requests and % pam_actuations', n_requests, n_actuations;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2b. New unique key and FKs, NOT VALID first; validated below only when no
--     row violates them, so an unexpected historical row cannot crash-loop
--     the boot. NOT VALID constraints are still enforced for every new write.
-- ---------------------------------------------------------------------------
ALTER TABLE public.pam_actuations DROP CONSTRAINT IF EXISTS pam_actuations_id_device_org_epoch_key;
ALTER TABLE public.pam_actuations
  ADD CONSTRAINT pam_actuations_id_device_org_epoch_key UNIQUE (id, device_id, org_id, device_epoch);

ALTER TABLE public.elevation_requests
  ADD CONSTRAINT elevation_requests_device_epoch_fkey
  FOREIGN KEY (device_id, org_id, device_epoch)
  REFERENCES public.device_ownership_epochs (device_id, org_id, epoch)
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.pam_actuations
  ADD CONSTRAINT pam_actuations_device_epoch_fkey
  FOREIGN KEY (device_id, org_id, device_epoch)
  REFERENCES public.device_ownership_epochs (device_id, org_id, epoch)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.pam_actuation_results
  ADD CONSTRAINT pam_actuation_results_actuation_epoch_fkey
  FOREIGN KEY (actuation_id, device_id, org_id, device_epoch)
  REFERENCES public.pam_actuations (id, device_id, org_id, device_epoch)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.elevation_requests r
   WHERE NOT EXISTS (SELECT 1 FROM public.device_ownership_epochs e
                      WHERE (e.device_id, e.org_id, e.epoch) = (r.device_id, r.org_id, r.device_epoch));
  IF n = 0 THEN
    ALTER TABLE public.elevation_requests VALIDATE CONSTRAINT elevation_requests_device_epoch_fkey;
  ELSE
    RAISE WARNING 'pam chain epoch anchor: % elevation_requests have no matching ownership epoch; elevation_requests_device_epoch_fkey left NOT VALID', n;
  END IF;

  SELECT count(*) INTO n FROM public.pam_actuations a
   WHERE NOT EXISTS (SELECT 1 FROM public.device_ownership_epochs e
                      WHERE (e.device_id, e.org_id, e.epoch) = (a.device_id, a.org_id, a.device_epoch));
  IF n = 0 THEN
    ALTER TABLE public.pam_actuations VALIDATE CONSTRAINT pam_actuations_device_epoch_fkey;
  ELSE
    RAISE WARNING 'pam chain epoch anchor: % pam_actuations have no matching ownership epoch; pam_actuations_device_epoch_fkey left NOT VALID', n;
  END IF;

  SELECT count(*) INTO n FROM public.pam_actuation_results x
   WHERE NOT EXISTS (SELECT 1 FROM public.pam_actuations a
                      WHERE (a.id, a.device_id, a.org_id, a.device_epoch)
                          = (x.actuation_id, x.device_id, x.org_id, x.device_epoch));
  IF n = 0 THEN
    ALTER TABLE public.pam_actuation_results VALIDATE CONSTRAINT pam_actuation_results_actuation_epoch_fkey;
  ELSE
    RAISE WARNING 'pam chain epoch anchor: % pam_actuation_results do not match their actuation epoch (append-only, not rewritten); pam_actuation_results_actuation_epoch_fkey left NOT VALID', n;
  END IF;
END
$$;

-- The insert guard sets the anchor on these two; results keep the default and
-- their 4-column FK to the actuation enforces the right value.
ALTER TABLE public.elevation_requests ALTER COLUMN device_epoch DROP DEFAULT;
ALTER TABLE public.pam_actuations     ALTER COLUMN device_epoch DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 4. Freeze and insert guard.
--
-- SECURITY DEFINER with in-body system scope (saved and restored before every
-- RETURN; an error aborts the statement and rolls the set_config back too):
-- the actuated-or-not check and the device read must not depend on the
-- caller's RLS context, or a caller that cannot see the actuation row could
-- re-anchor evidence. A function-level SET "breeze.scope" is not usable (needs
-- superuser in prod; migrationGucAttributes.test.ts).
--
-- Lock order (spec §9): the device row FOR SHARE, which conflicts with an org
-- change's UPDATE of that row, so an insert and a move serialize: either the
-- insert commits first in epoch n and the move's guard sees it, or the move
-- commits first and the insert sees epoch n+1 / the new org and is refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_pam_chain_epoch_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  d_org uuid;
  d_epoch integer;
  actuated boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.device_id, NEW.org_id, NEW.device_epoch)
         IS NOT DISTINCT FROM (OLD.device_id, OLD.org_id, OLD.device_epoch) THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('breeze.scope', 'system', true);

  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'elevation_requests' AND NEW.device_id = OLD.device_id THEN
      SELECT EXISTS (SELECT 1 FROM public.pam_actuations a WHERE a.elevation_request_id = OLD.id)
        INTO actuated;
      IF NOT actuated THEN
        SELECT d.org_id, d.ownership_epoch INTO d_org, d_epoch
          FROM public.devices d WHERE d.id = NEW.device_id FOR SHARE;
        IF FOUND AND d_org = NEW.org_id THEN
          NEW.device_epoch := d_epoch;
          PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
          RETURN NEW;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'An elevation request without actuation can only follow its device into the device current ownership epoch';
      END IF;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'PAM chain epoch ownership is immutable';
  END IF;

  -- INSERT
  SELECT d.org_id, d.ownership_epoch INTO d_org, d_epoch
    FROM public.devices d WHERE d.id = NEW.device_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM chain must be created in the device current ownership epoch';
  END IF;
  IF NEW.device_epoch IS NULL THEN
    NEW.device_epoch := d_epoch;
  END IF;
  IF d_org IS DISTINCT FROM NEW.org_id OR d_epoch IS DISTINCT FROM NEW.device_epoch THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM chain must be created in the device current ownership epoch';
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_pam_chain_epoch_guard() FROM PUBLIC;

CREATE TRIGGER elevation_requests_epoch_guard
  BEFORE INSERT OR UPDATE OF device_id, org_id, device_epoch ON public.elevation_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_pam_chain_epoch_guard();

CREATE TRIGGER pam_actuations_epoch_guard
  BEFORE INSERT OR UPDATE OF device_id, org_id, device_epoch ON public.pam_actuations
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_pam_chain_epoch_guard();

-- ---------------------------------------------------------------------------
-- 5. Closed predicate (spec §5) and terminal `cleaned`.
--
-- Invoker rights: callers read their own org's rows under their own RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pam_actuation_is_closed(a public.pam_actuations)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT a.desired_state = 'cleanup'
     AND a.observed_state = 'cleaned'
     AND a.cleaned_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.pam_actuation_results r
        WHERE r.actuation_id = a.id
          AND r.org_id = a.org_id
          AND r.generation = a.generation
          AND r.result_kind = 'cleaned'
     );
$$;

-- Body copied from the live definition (2026-09-25-pam-actuation-org-immutable.sql),
-- plus the terminal-cleaned check. No lifecycle path leaves `cleaned`
-- (pamActuationLifecycle.ts, pamActuationResult.ts, pamActuationWorker.ts).
CREATE OR REPLACE FUNCTION public.pam_actuations_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'PAM actuation tenancy is immutable';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM actuation generation cannot decrease';
  END IF;
  IF OLD.desired_state = 'cleanup' AND NEW.desired_state <> 'cleanup' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM cleanup tombstone is irreversible';
  END IF;
  IF OLD.observed_state = 'cleaned' AND NEW.observed_state <> 'cleaned' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM cleaned state is terminal';
  END IF;
  RETURN NEW;
END;
$$;
