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
-- Schema-only: no row writes, so no breeze.scope elevation. Idempotent: the
-- constraint is dropped and re-created with the full list every time.

ALTER TABLE remote_sessions
  DROP CONSTRAINT IF EXISTS remote_sessions_end_reason_check;

ALTER TABLE remote_sessions
  ADD CONSTRAINT remote_sessions_end_reason_check
  CHECK (end_reason IS NULL OR end_reason IN ('ended_by_user', 'operator_ended', 'viewer_closed', 'connection_lost', 'peer_disconnected', 'never_connected', 'superseded', 'capture_failed', 'start_failed', 'consent_denied', 'access_revoked', 'max_duration', 'device_removed'));
