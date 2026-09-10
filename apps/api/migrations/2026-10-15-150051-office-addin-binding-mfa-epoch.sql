-- Bind Office add-in technician authority to the exact MFA generation that
-- established it. Existing rows have no trustworthy historical MFA epoch, so
-- fail them closed by revoking them before filling the new required column.
-- Affected technicians must complete the ordinary binding ceremony again.

ALTER TABLE office_addin_user_bindings
  ADD COLUMN IF NOT EXISTS bound_mfa_epoch integer;

-- autoMigrate may run as a non-BYPASSRLS owner. Elect the transaction-local
-- system scope before invalidating/backfilling partner-axis binding rows.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  invalidated_count integer;
  backfilled_count integer;
BEGIN
  UPDATE office_addin_user_bindings
     SET revoked_at = COALESCE(revoked_at, now()),
         revoked_by = NULL
   WHERE bound_mfa_epoch IS NULL
     AND revoked_at IS NULL;
  GET DIAGNOSTICS invalidated_count = ROW_COUNT;
  RAISE WARNING 'invalidated % legacy Office add-in binding(s) without MFA-generation provenance', invalidated_count;

  UPDATE office_addin_user_bindings b
     SET bound_mfa_epoch = u.mfa_epoch
    FROM users u
   WHERE b.user_id = u.id
     AND b.bound_mfa_epoch IS NULL;
  GET DIAGNOSTICS backfilled_count = ROW_COUNT;
  RAISE WARNING 'backfilled MFA generation on % revoked Office add-in binding row(s)', backfilled_count;
END $$;

ALTER TABLE office_addin_user_bindings
  ALTER COLUMN bound_mfa_epoch SET NOT NULL;
