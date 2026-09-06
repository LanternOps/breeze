-- Phase D (payment pull-back) — Task 1. accounting_connections gains a keyed
-- realm fingerprint (realm_id_encrypted uses a random IV, so SQL cannot query
-- it), the per-connection pull switch, and the clean-run reconcile stamp.
-- cdc_cursor already exists (2026-06-23-quickbooks-accounting-connections.sql).
-- No RLS changes: accounting_connections is partner-axis and already
-- ENABLE+FORCE with a partner policy; no new table.
--
-- realm_id_fingerprint is populated by the APP, never here: the HMAC key lives
-- in the process, so SQL cannot compute it. See backfillRealmFingerprints().

ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS realm_id_fingerprint text;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS pull_payments boolean NOT NULL DEFAULT true;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_provider_realm_fp_idx
  ON accounting_connections (provider, realm_id_fingerprint)
  WHERE realm_id_fingerprint IS NOT NULL;
