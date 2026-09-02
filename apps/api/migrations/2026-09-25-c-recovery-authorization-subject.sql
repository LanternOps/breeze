-- Persist the actual initiating authorization subject on durable recovery work.
-- Sequenced after the already-shipped 2026-09-24-b migration set.
-- Historical created_by / initiated_by attribution is deliberately not used to
-- infer origin: API-key, OAuth, and interactive user work are indistinguishable
-- through those columns alone.

ALTER TABLE recovery_tokens
  ADD COLUMN IF NOT EXISTS authorization_principal_kind varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_id text,
  ADD COLUMN IF NOT EXISTS authorization_grant_revision varchar(255),
  ADD COLUMN IF NOT EXISTS authorization_state varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS authorization_denial_code varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_checked_at timestamptz;

ALTER TABLE recovery_media_artifacts
  ADD COLUMN IF NOT EXISTS authorization_principal_kind varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_id text,
  ADD COLUMN IF NOT EXISTS authorization_grant_revision varchar(255),
  ADD COLUMN IF NOT EXISTS authorization_state varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS authorization_denial_code varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_checked_at timestamptz;

ALTER TABLE recovery_boot_media_artifacts
  ADD COLUMN IF NOT EXISTS authorization_principal_kind varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_id text,
  ADD COLUMN IF NOT EXISTS authorization_grant_revision varchar(255),
  ADD COLUMN IF NOT EXISTS authorization_state varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS authorization_denial_code varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_checked_at timestamptz;

ALTER TABLE restore_jobs
  ADD COLUMN IF NOT EXISTS authorization_principal_kind varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_id text,
  ADD COLUMN IF NOT EXISTS authorization_grant_revision varchar(255),
  ADD COLUMN IF NOT EXISTS authorization_state varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS authorization_denial_code varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_checked_at timestamptz;

ALTER TABLE dr_executions
  ADD COLUMN IF NOT EXISTS authorization_principal_kind varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_id text,
  ADD COLUMN IF NOT EXISTS authorization_grant_revision varchar(255),
  ADD COLUMN IF NOT EXISTS authorization_state varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS authorization_denial_code varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_checked_at timestamptz;

ALTER TABLE c2c_backup_jobs
  ADD COLUMN IF NOT EXISTS operation_kind varchar(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_kind varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS authorization_principal_id text,
  ADD COLUMN IF NOT EXISTS authorization_grant_revision varchar(255),
  ADD COLUMN IF NOT EXISTS authorization_state varchar(40) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS authorization_denial_code varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_checked_at timestamptz;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'recovery_tokens',
    'recovery_media_artifacts',
    'recovery_boot_media_artifacts',
    'restore_jobs',
    'dr_executions',
    'c2c_backup_jobs'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_authorization_principal_kind_chk'
        AND conrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (authorization_principal_kind IN (''user_session'', ''client_user'', ''api_key'', ''oauth_grant'', ''ai_agent'', ''system'', ''unknown''))',
        table_name,
        table_name || '_authorization_principal_kind_chk'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_authorization_state_chk'
        AND conrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (authorization_state IN (''pending'', ''authorized'', ''denied'', ''quarantined_authorization_unknown'', ''not_required''))',
        table_name,
        table_name || '_authorization_state_chk'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_authorization_subject_tuple_chk'
        AND conrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (((authorization_principal_kind = ''unknown'') AND authorization_principal_id IS NULL AND authorization_grant_revision IS NULL) OR ((authorization_principal_kind <> ''unknown'') AND length(btrim(authorization_principal_id)) > 0 AND length(btrim(authorization_grant_revision)) > 0))',
        table_name,
        table_name || '_authorization_subject_tuple_chk'
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'c2c_backup_jobs_operation_kind_chk'
      AND conrelid = 'c2c_backup_jobs'::regclass
  ) THEN
    ALTER TABLE c2c_backup_jobs
      ADD CONSTRAINT c2c_backup_jobs_operation_kind_chk
      CHECK (operation_kind IN ('sync', 'restore', 'unknown'));
  END IF;
END $$;

-- Unknown nonterminal work is quarantined without rewriting its operational
-- status. Terminal historical rows remain terminal and are marked not_required.
DO $$
DECLARE
  affected bigint;
BEGIN
  UPDATE recovery_tokens
  SET authorization_state = CASE
    WHEN status IN ('revoked', 'expired', 'used') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('revoked', 'expired', 'used') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'classified % legacy recovery_tokens authorization subjects', affected;
  END IF;

  UPDATE recovery_media_artifacts
  SET authorization_state = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'classified % legacy recovery_media_artifacts authorization subjects', affected;
  END IF;

  UPDATE recovery_boot_media_artifacts
  SET authorization_state = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('ready', 'ready_signed', 'legacy_unsigned', 'failed', 'expired') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'classified % legacy recovery_boot_media_artifacts authorization subjects', affected;
  END IF;

  UPDATE restore_jobs
  SET authorization_state = CASE
    WHEN status IN ('completed', 'failed', 'cancelled', 'partial') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('completed', 'failed', 'cancelled', 'partial') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'classified % legacy restore_jobs authorization subjects', affected;
  END IF;

  UPDATE dr_executions
  SET authorization_state = CASE
    WHEN status IN ('completed', 'failed', 'aborted') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('completed', 'failed', 'aborted') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'classified % legacy dr_executions authorization subjects', affected;
  END IF;

  UPDATE c2c_backup_jobs
  SET operation_kind = 'unknown',
  authorization_state = CASE
    WHEN status IN ('completed', 'failed') THEN 'not_required'
    ELSE 'quarantined_authorization_unknown'
  END,
  authorization_denial_code = CASE
    WHEN status IN ('completed', 'failed') THEN NULL
    ELSE 'authorization_subject_unknown'
  END
  WHERE authorization_principal_kind = 'unknown'
    AND authorization_state = 'pending';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'classified % legacy c2c_backup_jobs authorization subjects', affected;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS recovery_tokens_authorization_claim_idx
  ON recovery_tokens (status, authorization_state)
  WHERE status IN ('active', 'authenticated');
CREATE INDEX IF NOT EXISTS recovery_media_artifacts_authorization_claim_idx
  ON recovery_media_artifacts (status, authorization_state)
  WHERE status IN ('pending', 'building');
CREATE INDEX IF NOT EXISTS recovery_boot_media_artifacts_authorization_claim_idx
  ON recovery_boot_media_artifacts (status, authorization_state)
  WHERE status IN ('pending', 'building');
CREATE INDEX IF NOT EXISTS restore_jobs_authorization_claim_idx
  ON restore_jobs (status, authorization_state)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS dr_executions_authorization_claim_idx
  ON dr_executions (status, authorization_state)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS c2c_backup_jobs_authorization_claim_idx
  ON c2c_backup_jobs (status, authorization_state)
  WHERE status IN ('pending', 'running');
