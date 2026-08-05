-- @no-transaction
-- device_network has only a primary key on `id` — no index on device_id.
-- Every read of the table is by device_id (the device-detail /network route,
-- the org/device cascade delete, and now the Devices list's batched LAN-IP
-- lookup for #2503), so each of those was a sequential scan of the whole
-- table. At the 10k-agent target with ~4 interface rows per device that is a
-- ~40k-row scan on every Devices page load, which is what made this worth
-- fixing rather than leaving as latent debt.
--
-- Partial-index alternative (WHERE is_primary) was rejected: the cascade and
-- detail readers want every interface row for a device, not just the primary,
-- so the plain device_id index serves all three callers.
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the
-- build does not take a SHARE lock on `device_network` at deploy time — the
-- agent inventory ingest deletes and re-inserts every row for a device on each
-- run, so a blocking build would stall inventory writes fleet-wide.
CREATE INDEX CONCURRENTLY IF NOT EXISTS device_network_device_id_idx
  ON device_network (device_id);
