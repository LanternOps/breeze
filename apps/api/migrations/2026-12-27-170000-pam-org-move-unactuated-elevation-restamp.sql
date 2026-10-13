-- PAM ownership epochs W6-pre (#8746, feature #8202; carry-forward from W2
-- #8514): a device org move must leave every ACTUATED elevation request where
-- it is, in every ownership epoch, while un-actuated requests keep following
-- the device.
--
-- Before this file, breeze_cascade_device_org_id() (AFTER UPDATE OF org_id on
-- devices) restamped `elevation_requests` like any other device child:
--   UPDATE elevation_requests SET org_id = NEW.org_id
--    WHERE device_id = NEW.id AND org_id IS DISTINCT FROM NEW.org_id
-- That matches an earlier epoch's actuated request too (device moved A -> B,
-- then B -> C: the epoch-1 request in A is "distinct from C"), and
-- breeze_pam_chain_epoch_guard() refuses that restamp with 42501, aborting
-- the whole move. The device-move guard does not stop this case: it only
-- refuses while the device has actuations in its CURRENT org.
--
-- 1. breeze_device_child_orgid_tables() excludes elevation_requests, so the
--    generic loop (and the rls-coverage device-child drift audit, for which a
--    historical evidence row legitimately disagrees with its device) no
--    longer treats it as a plain device child.
-- 2. breeze_restamp_unactuated_elevation_requests(), a new AFTER UPDATE OF
--    org_id trigger on devices, restamps only requests no pam_actuations row
--    references — the guard's own "actuated" test — so the guard re-anchors
--    each into the device's new epoch exactly as before. An actuated request
--    of ANY epoch is never touched.
--
-- Visibility: like the loop it replaces (breeze_cascade_device_org_id() is
-- SECURITY DEFINER with the same search_path), it does not elevate
-- breeze.scope: the statement sees what the cascade loop saw. A request and
-- its actuation share org_id (the composite (elevation_request_id, org_id)
-- FK) and both tables gate SELECT and UPDATE on breeze_has_org_access(org_id),
-- so any request the statement can restamp has its actuation visible to the
-- NOT EXISTS probe.
--
-- Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Writes no rows, so
-- no breeze.scope election. No inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. Generic device-move restamp: exclude elevation_requests.
-- Body copied VERBATIM from the newest definition,
-- 2026-12-17-130000-device-ownership-epochs.sql (verified with
-- `grep -l 'FUNCTION public.breeze_device_child_orgid_tables' apps/api/migrations/*.sql | sort`
-- — re-run it before committing and re-copy from the newest hit if that
-- changed), with only elevation_requests added to the NOT IN list.
-- deviceOwnershipEpochs.integration.test.ts pins the full exclusion set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    -- ai_operator_tasks: AI Operator task history stays with the SOURCE org
    -- (#5205 W03, #5208). org_id is immutable and anchors composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, an outbox wake, a target, a step, an event, a linked run
    -- or a linked intent. moveOrg.ts and this trigger both detach device_id
    -- and fence the task instead.
    -- ai_operator_task_targets (recipe library E2): same rule one level down.
    -- The target's org_id is its TASK's org_id and anchors
    -- ai_operator_task_targets_task_org_fk, so re-stamping it to the
    -- destination org while the task stays behind aborts the move with 23503.
    -- Section 9 detaches device_id and stamps the reason instead.
    -- fix_outcomes (AI Suggested Fixes W1): attempt history stays with the org
    -- the attempt ran in; (org_id, partner_id) composite FK would 23503 on a
    -- cross-partner move. The outcome sweeper cancels in-flight rows whose
    -- device left the org.
    -- device_ownership_epochs / device_ownership_epoch_closures: ownership
    -- lineage is append-only; an org change appends a new epoch through
    -- breeze_device_ownership_epoch_advance() instead (PAM ownership epochs
    -- #8203, spec §4). pam_ledger_retirements has no org_id; listed for clarity.
    -- elevation_requests (PAM ownership epochs W6-pre, #8746): an ACTUATED
    -- request is PAM-chain evidence frozen at its (org_id, device_epoch);
    -- breeze_pam_chain_epoch_guard() refuses (42501) any restamp of it, so a
    -- move of a device whose earlier epoch holds one aborted here. Un-actuated
    -- requests still follow the device: breeze_restamp_unactuated_elevation_
    -- requests() (its own AFTER UPDATE OF org_id trigger on devices) restamps
    -- exactly those, and the guard re-anchors them into the new epoch.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'ai_operator_task_targets',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects',
      'fix_outcomes',
      'device_ownership_epochs',
      'device_ownership_epoch_closures',
      'pam_ledger_retirements',
      'elevation_requests'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;


-- ---------------------------------------------------------------------------
-- 2. Un-actuated elevation requests follow the device.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_restamp_unactuated_elevation_requests()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    UPDATE public.elevation_requests r
       SET org_id = NEW.org_id
     WHERE r.device_id = NEW.id
       AND r.org_id IS DISTINCT FROM NEW.org_id
       AND NOT EXISTS (
             SELECT 1 FROM public.pam_actuations a
              WHERE a.elevation_request_id = r.id
           );
  END IF;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_restamp_unactuated_elevation_requests() FROM PUBLIC;

DROP TRIGGER IF EXISTS devices_restamp_unactuated_elevation_requests ON public.devices;
CREATE TRIGGER devices_restamp_unactuated_elevation_requests
  AFTER UPDATE OF org_id ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.breeze_restamp_unactuated_elevation_requests();
