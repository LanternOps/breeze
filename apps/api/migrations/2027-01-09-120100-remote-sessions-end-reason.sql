-- 2027-01-09-120100: remote_sessions.end_reason (#10190 W06).
--
-- Why a remote session ended, when that is known and is not already carried by
-- status / error_message. The one value today is 'ended_by_user': the person at
-- the keyboard ended the session from the on-screen indicator (policy
-- config_policy_remote_access_settings.allow_user_end_session). The agent
-- reports it as its own desk-userend-<sessionId> command result just before its
-- normal stop; the API records it here and writes the audit event
-- remote.session.ended_by_user, so the technician sees why the session closed.
--
-- NULL = not known / not a user end (every existing row, and every session an
-- operator, a sweep or a peer drop ended). The CHECK keeps the column a closed
-- set; widening it is a later migration.
--
-- Tenancy: remote_sessions already has org_id, RLS, and its cascade / merge /
-- export registrations. A new column on an org-cascade table needs an export
-- policy classification: end_reason is plain non-secret text ->
-- CORE_TENANT_EXPORT_POLICY.remote_sessions.included (same PR).
--
-- Schema-only: no row writes, so no breeze.scope elevation. Idempotent.

ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS end_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'remote_sessions_end_reason_check'
      AND conrelid = 'public.remote_sessions'::regclass
  ) THEN
    ALTER TABLE remote_sessions
      ADD CONSTRAINT remote_sessions_end_reason_check
      CHECK (end_reason IS NULL OR end_reason IN ('ended_by_user'));
  END IF;
END $$;
