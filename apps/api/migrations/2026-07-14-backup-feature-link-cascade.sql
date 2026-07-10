-- #2302: Deleting a configuration policy / backup feature link 500s once the
-- backup has run, because backup_jobs.feature_link_id -> config_policy_feature_links
-- has no ON DELETE CASCADE (unlike EVERY other feature-link child table). The link
-- delete (removeFeatureLink is a bare delete that relies on FK cascade) then hits
-- the FK and returns 500, permanently blocking deletion of any policy whose backup
-- has ever produced a job row (including failed runs).
--
-- Fix: unblock the delete without destroying backup history.
--   backup_jobs.feature_link_id -> config_policy_feature_links : ON DELETE SET NULL
--     feature_link_id is nullable and backup_jobs are execution/audit history with
--     a lifecycle independent of the policy link. Cascade here would silently wipe
--     the entire backup history (and the only rows tracking objects already in
--     storage, which aren't cleaned up) merely on unlinking the Backup feature.
--     SET NULL fixes the 500 while keeping history attached to the device.
--   backup_snapshots.job_id            -> backup_jobs : ON DELETE CASCADE
--   backup_verifications.backup_job_id -> backup_jobs : ON DELETE CASCADE
--     these children genuinely have no meaning without their job row, so they
--     cascade when a backup_job itself is deleted (retention / org-delete).
-- (backup_snapshots' own children, e.g. backup_snapshot_files, already cascade.)
--
-- Idempotent: each FK is looked up by (table, column) so we drop whatever it is
-- currently named, then re-add a canonically-named constraint WITH ON DELETE CASCADE.
-- Re-applying drops the cascade constraint and re-adds an identical one (net no-op).

DO $$
DECLARE
  cname text;
BEGIN
  -- 1) backup_jobs.feature_link_id -> config_policy_feature_links(id)
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
  WHERE con.contype = 'f' AND c.relname = 'backup_jobs' AND a.attname = 'feature_link_id';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE backup_jobs DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE backup_jobs
    ADD CONSTRAINT backup_jobs_feature_link_id_fkey
    FOREIGN KEY (feature_link_id) REFERENCES config_policy_feature_links (id) ON DELETE SET NULL;

  -- 2) backup_snapshots.job_id -> backup_jobs(id)
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
  WHERE con.contype = 'f' AND c.relname = 'backup_snapshots' AND a.attname = 'job_id';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE backup_snapshots DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES backup_jobs (id) ON DELETE CASCADE;

  -- 3) backup_verifications.backup_job_id -> backup_jobs(id)
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
  WHERE con.contype = 'f' AND c.relname = 'backup_verifications' AND a.attname = 'backup_job_id';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE backup_verifications DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE backup_verifications
    ADD CONSTRAINT backup_verifications_backup_job_id_fkey
    FOREIGN KEY (backup_job_id) REFERENCES backup_jobs (id) ON DELETE CASCADE;
END $$;
