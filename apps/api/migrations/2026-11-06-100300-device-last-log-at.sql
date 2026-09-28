-- #7067 item 2: make "heartbeating but shipping no logs" a queryable
-- condition instead of an absence. Tracks the latest agent-logs ingest time
-- per device, updated cheaply (throttled — see logs.ts) from the agent-logs
-- ingest path. Nullable, no backfill: a device that has never shipped a log,
-- or predates this migration, simply has NULL until its next batch lands.
-- devices is RLS shape 1 (org_id) and already covered; no new policy needed.
-- Idempotent; writes no rows (so no breeze.scope election is needed).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_log_at timestamptz;
