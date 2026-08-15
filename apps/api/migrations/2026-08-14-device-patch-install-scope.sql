-- #2727: record WHICH Windows install scope a pending patch was discovered at.
--
-- The agent now scans winget twice: machine scope as SYSTEM (as before) plus a
-- best-effort pass inside the interactive user's session, which is the only way
-- per-user installs (Chrome/Zoom/Slack/Discord) are visible at all. The two
-- passes are merged and deduped agent-side, so this stays one row per
-- (device, patch) — the column records which pass saw it.
--
-- It matters beyond display: a scan taken while nobody is logged in covers
-- machine scope only, and sweeping its (absent) per-user results to 'missing'
-- would tombstone rows that scan never looked at — the #2217 failure mode, one
-- axis down. The ingest route therefore only sweeps user-scope rows when the
-- agent reports that the user-context pass actually ran.
--
-- NULL means "scope unknown": every row written before this migration, and
-- every provider with no scope concept (Windows Update, apt, homebrew...).
-- NULL is treated as machine-wide/sweepable, preserving today's behaviour.
ALTER TABLE device_patches ADD COLUMN IF NOT EXISTS scope varchar(16);

DO $$ BEGIN
  ALTER TABLE device_patches
    ADD CONSTRAINT device_patches_scope_chk
    CHECK (scope IS NULL OR scope IN ('machine', 'user'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;

-- Backs the sweep's "protect user-scope rows" filter and the per-device
-- per-user patch listing. Partial: user-scope rows are the rare minority.
CREATE INDEX IF NOT EXISTS idx_device_patches_user_scope
  ON device_patches (device_id)
  WHERE scope = 'user';
