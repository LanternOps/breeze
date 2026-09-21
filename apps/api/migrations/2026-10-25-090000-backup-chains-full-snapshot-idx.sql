-- #5421: retention now checks, per candidate snapshot row, whether an ACTIVE
-- backup_chains row still anchors it as its full snapshot (jobs/backupRetention.ts,
-- deleteSnapshotRow). backup_chains carried no index on full_snapshot_id, so that
-- lookup would seq-scan the whole table once per candidate row on every retention
-- sweep. Partial index -- the query's predicate is always `is_active`.
CREATE INDEX IF NOT EXISTS backup_chains_full_snapshot_active_idx
  ON backup_chains (full_snapshot_id)
  WHERE is_active;
