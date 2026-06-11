-- @no-transaction
-- audit_logs: scale indexes. Today the table has only pkey + idx_audit_logs_initiated_by.
-- At 438k rows (in a 70-device deployment), a typical org-scoped audit list seq-scans
-- ~146k rows per worker (Parallel Seq Scan). At ~1k devices steady-state the table
-- grows to ~6M rows/month, at 10k devices ~60M+. Without these indexes, the
-- existing 170ms scan becomes ~24 seconds.
--
-- The details JSONB column is queried by sub-key (details->>'deviceId') in
-- devices/events.ts:75 — we add an expression btree (cheaper than full GIN, and
-- targeted at the actual query rather than arbitrary JSONB paths).
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the
-- build does not take a SHARE lock on `audit_logs` at deploy time — critical
-- because every API route writes here.

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_org_timestamp_idx
  ON audit_logs (org_id, timestamp DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_actor_email_timestamp_idx
  ON audit_logs (actor_email, timestamp DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_resource_type_id_timestamp_idx
  ON audit_logs (resource_type, resource_id, timestamp DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_details_device_id_idx
  ON audit_logs ((details->>'deviceId'));
