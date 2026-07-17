-- Incremental-backup dedup stats: files a run referenced from a prior
-- snapshot instead of re-transferring. NULL = agent didn't report dedup
-- (legacy agent, or a full backup that referenced nothing).
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS referenced_size bigint;
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS referenced_files integer;
