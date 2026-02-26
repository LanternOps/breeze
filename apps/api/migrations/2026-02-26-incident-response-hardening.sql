BEGIN;

DO $$
BEGIN
  CREATE TYPE incident_action_status AS ENUM ('pending', 'in_progress', 'completed', 'failed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE incident_hash_algorithm AS ENUM ('sha256');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE incident_actions
  ALTER COLUMN status TYPE incident_action_status
  USING (
    CASE lower(coalesce(status, ''))
      WHEN 'pending' THEN 'pending'
      WHEN 'in_progress' THEN 'in_progress'
      WHEN 'completed' THEN 'completed'
      WHEN 'failed' THEN 'failed'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE 'completed'
    END
  )::incident_action_status;

ALTER TABLE incident_actions
  ALTER COLUMN status SET DEFAULT 'completed';

ALTER TABLE incident_evidence
  ALTER COLUMN hash TYPE VARCHAR(64)
  USING left(lower(hash), 64);

ALTER TABLE incident_evidence
  ADD COLUMN IF NOT EXISTS hash_algorithm incident_hash_algorithm NOT NULL DEFAULT 'sha256';

ALTER TABLE incident_evidence
  DROP CONSTRAINT IF EXISTS incident_evidence_hash_sha256_chk;

ALTER TABLE incident_evidence
  ADD CONSTRAINT incident_evidence_hash_sha256_chk
  CHECK (hash IS NULL OR hash ~ '^[0-9a-f]{64}$');

ALTER TABLE incident_evidence
  DROP CONSTRAINT IF EXISTS incident_evidence_storage_path_scheme_chk;

ALTER TABLE incident_evidence
  ADD CONSTRAINT incident_evidence_storage_path_scheme_chk
  CHECK (storage_path ~ '^[a-z][a-z0-9+.-]*://.+');

COMMIT;
