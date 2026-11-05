-- #11014: in-flight "checked" counters for backup_jobs.
--
-- A resumed snapshot re-reads every file an earlier run already uploaded
-- (and, when continued from another job, every stored object) before its
-- first upload. On a multi-TB selection that pass takes hours with
-- transferred_size and file_count frozen at 0, so the stale reaper's
-- no-transfer rule failed healthy runs. Agents now report the files/bytes
-- they have finished checking; their increase advances last_progress_at.
--
-- Nullable scalar columns, no default, no backfill: NULL means the agent
-- never reported them. backup_jobs already has RLS and its org-cascade /
-- export-policy registration (columns classified in
-- tenantExportPolicyRegistry.ts).

ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS verified_size bigint;
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS verified_files integer;
