-- Bind Office add-in technician authority to the exact MFA generation that
-- established it. Existing rows have no trustworthy historical MFA epoch, so
-- fail them closed by revoking them before filling the new required column.
-- Affected technicians must complete the ordinary binding ceremony again.
--
-- The column defaults to 0 (rather than being left nullable) so an old API
-- replica mid-rollout (rolling deploy, or an image rollback) can still INSERT
-- into office_addin_user_bindings without supplying this column and without
-- hitting a NOT NULL violation. 0 is a safe sentinel: live users.mfa_epoch
-- values start at 1 and are only ever incremented, so a binding stuck at the
-- sentinel can never satisfy vetBinding's epoch comparison — it fails closed
-- exactly as a NULL would have.
ALTER TABLE office_addin_user_bindings
  ADD COLUMN IF NOT EXISTS bound_mfa_epoch integer NOT NULL DEFAULT 0;

-- autoMigrate may run as a non-BYPASSRLS owner. Elect the transaction-local
-- system scope before invalidating/backfilling partner-axis binding rows.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  invalidated_count integer;
  backfilled_count integer;
BEGIN
  -- Every binding that predates this migration lands on the 0 sentinel (it
  -- has no trustworthy historical MFA epoch). Revoke all of them
  -- unconditionally: every pre-existing Office add-in binding is revoked by
  -- this migration, full stop. Affected technicians must re-run the binding
  -- ceremony to obtain a binding row that records a real epoch.
  UPDATE office_addin_user_bindings
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE bound_mfa_epoch = 0
     AND revoked_at IS NULL;
  GET DIAGNOSTICS invalidated_count = ROW_COUNT;
  RAISE WARNING 'invalidated % legacy Office add-in binding(s) without MFA-generation provenance', invalidated_count;

  -- Every row this backfill can touch was either just revoked above or was
  -- already revoked before this migration ran (revoked_at IS NOT NULL) — it
  -- only records the user's current MFA generation for forensic/audit
  -- purposes on rows that can no longer authorize anything; it never
  -- un-revokes a binding.
  UPDATE office_addin_user_bindings b
     SET bound_mfa_epoch = u.mfa_epoch
    FROM users u
   WHERE b.user_id = u.id
     AND b.bound_mfa_epoch = 0
     AND b.revoked_at IS NOT NULL;
  GET DIAGNOSTICS backfilled_count = ROW_COUNT;
  RAISE WARNING 'backfilled MFA generation on % revoked Office add-in binding row(s)', backfilled_count;
END $$;
