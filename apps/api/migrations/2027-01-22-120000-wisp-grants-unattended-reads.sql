-- #10973 / Wisp delegation W3 (#11086): the grant-level "unattended reads"
-- switch. Stored twice (plan Decision 7):
--   * wisp_grant_revisions.ceiling_snapshot->>'unattendedReads' is the PINNED
--     authorization. Only a step-up refresh writes a flagged revision, and a
--     session or run keeps the revision it was admitted under.
--   * wisp_grants.unattended_reads is the LIVE switch, so turning it off takes
--     effect on the next call.
-- The effective value is pinned AND live. Default off.
--
-- Writes no rows; elects system scope first anyway, per the migrations README.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_grants ADD COLUMN IF NOT EXISTS unattended_reads boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- wisp_grants_update_guard — every rule from 2027-01-04-100100-wisp-grants.sql
-- is unchanged; two are added:
--   * a non-grantor may not change unattended_reads at all, in either
--     direction. A partner admin's brake is pause / revoke, which already
--     stops every path;
--   * unattended_reads = true requires the current revision to carry the
--     snapshot flag, checked whenever it turns on or the pointer moves. This
--     one binds system scope too: no path turns the switch on without a pin.
-- A revision erased underneath (ON DELETE SET NULL of current_revision_id)
-- clears the switch rather than blocking the erasure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wisp_grants_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_system boolean := public.breeze_current_scope() = 'system';
  v_status_changed boolean := NEW.status IS DISTINCT FROM OLD.status;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.grantor_user_id IS DISTINCT FROM OLD.grantor_user_id
     OR NEW.grantee IS DISTINCT FROM OLD.grantee
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: ownership columns are immutable';
  END IF;

  IF OLD.status IN ('revoked','expired') AND v_status_changed THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: a revoked or expired grant cannot change status';
  END IF;

  IF NOT v_system THEN
    IF NOT v_status_changed
       AND (NEW.paused_reason IS DISTINCT FROM OLD.paused_reason
            OR NEW.paused_at IS DISTINCT FROM OLD.paused_at
            OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
            -- revoked_by_user_id may only fall to NULL (ON DELETE SET NULL of the revoker).
            OR (NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id AND NEW.revoked_by_user_id IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: pause/revoke stamps change only with a status change';
    END IF;

    IF OLD.status = 'paused' AND NEW.status = 'active' AND OLD.paused_reason IS DISTINCT FROM 'user_paused' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: only a user pause can be resumed by a user';
    END IF;

    IF public.breeze_current_user_id() IS DISTINCT FROM OLD.grantor_user_id THEN
      IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR (v_status_changed AND NEW.status NOT IN ('paused','revoked'))
         OR (v_status_changed AND NEW.status = 'paused' AND OLD.status <> 'active') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: a partner admin may only pause, revoke, or change budget/tick';
      END IF;
      IF NEW.unattended_reads IS DISTINCT FROM OLD.unattended_reads THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: only the grantor can change unattended_reads';
      END IF;
    END IF;
  END IF;

  IF NEW.current_revision_id IS NULL AND OLD.current_revision_id IS NOT NULL THEN
    NEW.unattended_reads := false;
  END IF;

  IF NEW.unattended_reads
     AND (NOT OLD.unattended_reads OR NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.wisp_grant_revisions r
        WHERE r.id = NEW.current_revision_id
          AND r.grant_id = NEW.id
          AND r.ceiling_snapshot->>'unattendedReads' = 'true'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: unattended_reads requires a current revision that pins it';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- A grant is born with the switch off: turning it on is always a later,
-- step-up-bound refresh of a revision that already exists.
CREATE OR REPLACE FUNCTION public.wisp_grants_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unattended_reads AND public.breeze_current_scope() <> 'system' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: a new grant starts with unattended_reads off';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wisp_grants_insert_guard ON wisp_grants;
CREATE TRIGGER wisp_grants_insert_guard BEFORE INSERT ON wisp_grants
  FOR EACH ROW EXECUTE FUNCTION public.wisp_grants_insert_guard();
