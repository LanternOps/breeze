-- Bind installer bootstrap tokens to the exact
-- enrollment-key credential epoch from which they were issued. Rotation
-- increments the parent epoch, invalidating all outstanding older tokens.

DO $$
DECLARE
  parent_column_added boolean := false;
  token_column_added boolean := false;
  invalidated_parent_count bigint := 0;
  deleted_child_count bigint := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enrollment_keys'
      AND column_name = 'credential_generation'
  ) THEN
    ALTER TABLE enrollment_keys
      ADD COLUMN credential_generation integer NOT NULL DEFAULT 1;
    parent_column_added := true;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installer_bootstrap_tokens'
      AND column_name = 'parent_credential_generation'
  ) THEN
    ALTER TABLE installer_bootstrap_tokens
      ADD COLUMN parent_credential_generation integer NOT NULL DEFAULT 1;
    token_column_added := true;
  END IF;

  -- There is no historical epoch stamp from which to prove whether a legacy
  -- token predates its parent's last rotation. On first application only,
  -- advance every parent that has issued a token so all legacy token rows
  -- (backfilled at generation 1) fail closed. Replaying this migration after
  -- both columns exist is a true no-op and cannot invalidate post-migration
  -- generation-1 tokens belonging to newly created parents.
  IF parent_column_added OR token_column_added THEN
    UPDATE enrollment_keys AS parent
    SET credential_generation = 2
    WHERE parent.credential_generation = 1
      AND EXISTS (
        SELECT 1
        FROM installer_bootstrap_tokens AS token
        WHERE token.parent_enrollment_key_id = parent.id
      );
    GET DIAGNOSTICS invalidated_parent_count = ROW_COUNT;
    RAISE WARNING
      'installer bootstrap epoch cutover: invalidated legacy tokens for % parent enrollment key(s)',
      invalidated_parent_count;

    -- A successfully redeemed legacy token may already have minted a child
    -- enrollment key. Remove only unused children; used children are already
    -- exhausted (minted children are single-use) and remain as history.
    DELETE FROM enrollment_keys AS child
    WHERE child.usage_count = 0
      AND child.bootstrap_token_id IS NOT NULL;
    GET DIAGNOSTICS deleted_child_count = ROW_COUNT;
    RAISE WARNING
      'installer bootstrap epoch cutover: deleted % unused legacy derived enrollment key(s)',
      deleted_child_count;
  END IF;
END $$;

ALTER TABLE enrollment_keys
  ALTER COLUMN credential_generation SET DEFAULT 1,
  ALTER COLUMN credential_generation SET NOT NULL;

ALTER TABLE installer_bootstrap_tokens
  ALTER COLUMN parent_credential_generation SET DEFAULT 1,
  ALTER COLUMN parent_credential_generation SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enrollment_keys_credential_generation_positive'
      AND conrelid = 'enrollment_keys'::regclass
  ) THEN
    ALTER TABLE enrollment_keys
      ADD CONSTRAINT enrollment_keys_credential_generation_positive
      CHECK (credential_generation > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'installer_tokens_parent_generation_positive'
      AND conrelid = 'installer_bootstrap_tokens'::regclass
  ) THEN
    ALTER TABLE installer_bootstrap_tokens
      ADD CONSTRAINT installer_tokens_parent_generation_positive
      CHECK (parent_credential_generation > 0);
  END IF;
END $$;
