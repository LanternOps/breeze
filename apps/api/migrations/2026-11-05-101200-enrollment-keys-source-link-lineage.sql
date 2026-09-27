-- Record the parent-lineage of a child enrollment key minted by redeeming a
-- public short-link (/s/:code), so rotating the parent can find and revoke
-- outstanding children minted from the superseded credential. Mirrors the
-- existing bootstrap_token_id / parent_credential_generation pairing already
-- used for the bootstrap-token-derived redemption path.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enrollment_keys'
      AND column_name = 'source_link_key_id'
  ) THEN
    ALTER TABLE enrollment_keys
      ADD COLUMN source_link_key_id uuid REFERENCES enrollment_keys(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enrollment_keys'
      AND column_name = 'source_link_key_generation'
  ) THEN
    ALTER TABLE enrollment_keys
      ADD COLUMN source_link_key_generation integer;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'enrollment_keys'
      AND indexname = 'enrollment_keys_source_link_key_id_idx'
  ) THEN
    CREATE INDEX enrollment_keys_source_link_key_id_idx
      ON enrollment_keys (source_link_key_id)
      WHERE source_link_key_id IS NOT NULL;
  END IF;
END $$;
