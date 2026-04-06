ALTER TABLE local_vaults
ADD COLUMN IF NOT EXISTS last_sync_error text;
