-- #11013: a scheduled backup that finds its device offline waits for it.
--
-- catch_up_until is set only on a scheduled job whose dispatch found the agent
-- offline. While it is set and in the future the job stays `pending`, and the
-- next agent connect dispatches it; once it lapses the job fails as "Missed".
-- It is cleared when a catch-up dispatch claims the row. NULL on every other
-- job, so existing rows need no backfill.
--
-- Partial index: the agent websocket checks it on EVERY connect
-- (routes/agentWs.ts onOpen), so the lookup must stay cheap across a 10k-device
-- fleet. Only deferred rows are in it, which is a tiny share of backup_jobs.
--
-- backup_jobs is an existing org-cascade table: the new columns are classified
-- in CORE_TENANT_EXPORT_POLICY and need no RLS or cascade registration.

ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS catch_up_until timestamptz;

-- The backup_configs.approval_generation the waiting job was queued against.
-- The catch-up dispatch carries it, so a config edited while the job waited
-- fails it closed (site-ceiling gate contract §3) rather than running the edit.
ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS catch_up_config_generation integer;

CREATE INDEX IF NOT EXISTS backup_jobs_catch_up_device_idx
  ON backup_jobs (device_id)
  WHERE status = 'pending' AND catch_up_until IS NOT NULL;
