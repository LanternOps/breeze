-- Covering indexes for keyset pagination on GET /devices (Discussion #742 PR 3).
-- One index per whitelisted sort column, each carrying the `id` tiebreaker so
-- the keyset ORDER BY can be satisfied by an index-scan-backward with no sort
-- node. `IS NULL` partial dimension is omitted intentionally — keyset queries
-- with `ORDER BY last_seen_at DESC NULLS LAST, id DESC` use this index for the
-- non-NULL phase, and Postgres handles the NULL tail via a sequential scan of
-- the small NULL slice (a partial index here would not be a meaningful win
-- under any realistic NULL ratio and adds maintenance cost on every UPSERT).
--
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps each file in a tx).

CREATE INDEX IF NOT EXISTS devices_hostname_id_idx
  ON devices (hostname, id);

CREATE INDEX IF NOT EXISTS devices_last_seen_at_id_idx
  ON devices (last_seen_at, id);

CREATE INDEX IF NOT EXISTS devices_enrolled_at_id_idx
  ON devices (enrolled_at, id);
