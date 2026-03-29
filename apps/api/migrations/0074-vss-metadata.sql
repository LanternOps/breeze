-- VSS metadata column for backup jobs
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS vss_metadata jsonb;
