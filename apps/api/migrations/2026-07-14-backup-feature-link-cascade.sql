-- #2302: Deleting a configuration policy / backup feature link 500s once the
-- backup has run, because backup_jobs.feature_link_id -> config_policy_feature_links
-- has no ON DELETE CASCADE (unlike EVERY other feature-link child table). The link
-- delete (removeFeatureLink is a bare delete that relies on FK cascade) then hits
-- the FK and returns 500, permanently blocking deletion of any policy whose backup
-- has ever produced a job row (including failed runs).
--
-- Fix: give the backup feature-link -> jobs -> children chain the same ON DELETE
-- CASCADE the other feature-link children already have, so removing a feature link
-- (or deleting a policy) cleans up its dependent backup rows. Consistent with the
-- org-delete path, which already cascades/deletes backup_jobs (tenantCascade.ts).
--
-- Three FKs, in cascade order feature_link -> backup_jobs -> {snapshots,verifications}:
--   backup_jobs.feature_link_id           -> config_policy_feature_links.id
--   backup_snapshots.job_id               -> backup_jobs.id
--   backup_verifications.backup_job_id    -> backup_jobs.id
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
    FOREIGN KEY (feature_link_id) REFERENCES config_policy_feature_links (id) ON DELETE CASCADE;

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
