-- SentinelOne: record the last COMPLETE agent listing so s1Sync can mark
-- agents the console stopped returning as absent (#9248).
-- Idempotent; no row writes (nullable column add only), so no system-scope election needed.
ALTER TABLE s1_integrations ADD COLUMN IF NOT EXISTS last_full_agent_sync_at timestamp;
