-- Quick Support: keep the one-time code readable to the technician while the
-- session is pending (#11836).
--
-- code_encrypted holds the code sealed with the secret-encryption key, bound
-- to the row id (encryptedColumnRegistry, aadBinding 'row'). code_hash stays
-- the redeem lookup key; this column is display-only.
--
-- The CHECK makes "cleared on every transition out of pending" a database
-- invariant rather than a convention: an UPDATE that moves a row out of
-- 'pending' without nulling the sealed code fails instead of leaving a
-- readable code on a claimed, ended or expired session. Every existing row has
-- no sealed code (the column is new), so the constraint validates immediately.
--
-- No new policy: support_sessions' breeze_org_isolation_* policies are
-- row-level and already cover every column of the table.
--
-- Schema only; this file writes no rows.

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS code_encrypted text;

ALTER TABLE support_sessions
  DROP CONSTRAINT IF EXISTS support_sessions_code_encrypted_pending_chk;

ALTER TABLE support_sessions
  ADD CONSTRAINT support_sessions_code_encrypted_pending_chk
  CHECK (code_encrypted IS NULL OR status = 'pending');
