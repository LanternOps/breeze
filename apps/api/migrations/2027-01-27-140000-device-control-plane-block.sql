-- #8868: agent-reported control-plane block episode (a network filter,
-- captive portal or untrusted TLS interceptor answered in place of the
-- server). Two nullable columns, no default, no backfill: a metadata-only
-- ALTER on the hot devices table. control_plane_block_kind is a closed enum,
-- non-null only while an episode is active; control_plane_block is the last
-- episode (jsonb, export excludedOpen). Both are written by the heartbeat on
-- transition only (services/controlPlaneBlockHealth). Existing RLS policies on
-- devices cover the new columns. No rows are written, so no breeze.scope
-- election is needed.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS control_plane_block_kind varchar(24);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS control_plane_block jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_control_plane_block_kind_chk'
       AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE devices ADD CONSTRAINT devices_control_plane_block_kind_chk
      CHECK (control_plane_block_kind IS NULL OR control_plane_block_kind IN (
        'web_filter', 'captive_portal', 'plaintext_unknown', 'untrusted_certificate'
      ));
  END IF;
END $$;
