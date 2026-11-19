ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS full_backup_reason varchar(64);
COMMENT ON COLUMN backup_jobs.full_backup_reason IS 'Why dispatch gave this file/system_image run no incremental base (#11027). NULL = had a base, or not applicable.';
