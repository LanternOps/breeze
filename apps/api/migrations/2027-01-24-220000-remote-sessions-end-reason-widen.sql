-- @no-transaction
-- 2027-01-24-220000: widen remote_sessions.end_reason (#11839).
--
-- end_reason (2027-01-09-120100, #10190 W06) held one value, 'ended_by_user'.
-- Every other session end was a plain status = 'disconnected' with no reason,
-- so a lease revocation, a session that never connected and a normal hang-up
-- looked the same in the session history. Every server-side terminal writer now
-- records why the session ended, through the terminal-intent contract
-- (services/remoteDesktopTerminalIntent.ts terminalIntentSet). This widens the
-- CHECK to that closed set, REMOTE_SESSION_END_REASONS in
-- packages/shared/src/types/remoteSessionEndReason.ts (pinned to this file by
-- apps/api/src/db/schema/remoteSessionEndReason.test.ts).
--
-- Existing rows are left as they are: NULL means "not recorded" (rows written
-- before #11839), and 'ended_by_user' stays valid. No backfill: the old rows
-- do not carry enough to infer a reason reliably.
--
-- Tenancy: no new column. end_reason is already classified in
-- CORE_TENANT_EXPORT_POLICY.remote_sessions.included (plain non-secret text).
--
-- Schema-only: no row writes, so no breeze.scope elevation.
--
-- Locking. remote_sessions takes writes on every session start, offer and
-- end. A validated ADD CONSTRAINT ... CHECK holds ACCESS EXCLUSIVE for a full
-- scan of the table, and autoMigrate's per-file transaction would keep that
-- lock through any VALIDATE in the same file, so this file runs outside a
-- transaction (same shape as 2027-01-23-102000-alert-retention-fk-set-null.sql):
--   1. One DO block swaps the constraint for a NOT VALID one: catalog only, no
--      scan. It is one statement, so its own short transaction, and the drop
--      and the add commit together: there is never a moment with no CHECK, and
--      a failed add leaves the old CHECK in place. ACCESS EXCLUSIVE is held for
--      milliseconds once granted. lock_timeout (transaction-local, so it ends
--      with this statement) bounds the wait behind a long-running transaction:
--      after 5s the statement fails instead of queueing every later reader and
--      writer of remote_sessions behind it, autoMigrate aborts boot, and the
--      file re-runs cleanly on the next start. A NOT VALID CHECK still checks
--      every new and updated row.
--   2. VALIDATE scans the table under SHARE UPDATE EXCLUSIVE, which does not
--      conflict with reads or writes, so sessions keep starting and ending
--      during the scan.
--
-- Idempotent. Step 1 does nothing when the constraint already carries the
-- widened list ('device_removed' is a value only this file adds; the #10190
-- CHECK allows 'ended_by_user' alone), whether or not it is validated yet.
-- VALIDATE of a valid constraint is a no-op. An interruption between the two
-- steps leaves an enforcing NOT VALID constraint that the next run validates.

DO $$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.remote_sessions'::regclass
       AND conname = 'remote_sessions_end_reason_check'
       AND pg_get_constraintdef(oid) LIKE '%''device_removed''%'
  ) THEN
    ALTER TABLE public.remote_sessions
      DROP CONSTRAINT IF EXISTS remote_sessions_end_reason_check;

    ALTER TABLE public.remote_sessions
      ADD CONSTRAINT remote_sessions_end_reason_check
      CHECK (end_reason IS NULL OR end_reason IN ('ended_by_user', 'operator_ended', 'viewer_closed', 'connection_lost', 'peer_disconnected', 'never_connected', 'superseded', 'capture_failed', 'start_failed', 'consent_denied', 'access_revoked', 'max_duration', 'device_removed'))
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.remote_sessions VALIDATE CONSTRAINT remote_sessions_end_reason_check;
