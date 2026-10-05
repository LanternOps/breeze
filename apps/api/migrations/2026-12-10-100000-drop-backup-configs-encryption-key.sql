-- Drop the unused `backup_configs.encryption_key` column.
--
-- No code path writes it; backup encryption keys live in
-- `storage_encryption_keys` and are referenced from snapshots by id. The
-- column is plain text, so it is dropped only when it is empty: if any row
-- still holds a value the migration refuses and aborts the deploy, so the
-- value can be reviewed before anything is discarded.
--
-- System scope is elected first: backup_configs is FORCE ROW LEVEL SECURITY,
-- and under the default 'none' scope the count would see zero rows and the
-- guard would pass on a table that is not actually empty.
--
-- Idempotent: once the column is gone this is a no-op.

DO $$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'backup_configs'
       AND column_name = 'encryption_key'
  ) THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.backup_configs WHERE encryption_key IS NOT NULL'
     INTO remaining;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'refusing to drop backup_configs.encryption_key: % row(s) still hold a non-null value', remaining
      USING HINT = 'Review those rows and clear the column before re-running this migration.';
  END IF;

  ALTER TABLE public.backup_configs DROP COLUMN IF EXISTS encryption_key;
END $$;
