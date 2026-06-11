-- @no-transaction
-- Devices: scale indexes for /devices list endpoint and org-status filters.
-- The /devices list endpoint sorts ORDER BY last_seen_at DESC and filters by
-- org_id on every request, but the existing devices indexes are all specialised
-- (management_posture JSONB expressions, mtls_cert partial, quarantined partial)
-- so today this query plans as a Seq Scan + in-memory Sort. At 10k devices
-- that becomes the dominant cost of the page load.
--
-- The existing devices_quarantined_idx btree (org_id, status) WHERE status = 'quarantined'
-- is a partial index — it only helps quarantine-specific queries, not broader status filters.
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the
-- build does not take a SHARE lock on `devices` at deploy time.

CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_org_id_last_seen_at_idx
  ON devices (org_id, last_seen_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_org_id_status_idx
  ON devices (org_id, status);
