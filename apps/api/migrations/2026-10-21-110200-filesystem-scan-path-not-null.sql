-- Disk Cleanup v2 W03 (spec §4, §13 #7) — the CONTRACT half of the expand/
-- contract pair. W02 added `scan_path` nullable, backfilled it, and gave
-- device_filesystem_scan_state a UNIQUE index on (device_id, scan_path) so an
-- old replica writing NULL during the rolling deploy could not fail. By the
-- time this runs, every replica writes the column.
--
-- Idempotent throughout: re-applying is a no-op.

-- Any write below runs as the table OWNER under FORCE ROW LEVEL SECURITY, and
-- breeze_current_scope() defaults to 'none' — without this the cleanup UPDATEs
-- match zero rows SILENTLY and the RAISE WARNING prints a truthful-looking 0.
SELECT set_config('breeze.scope', 'system', true);

-- Defensive: W02's backfill should have left nothing, but SET NOT NULL on a
-- table with one stray NULL aborts the whole migration. Repair and SAY SO —
-- a silent fix destroys the forensic trail (lesson from 2026-06-10-c).
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE device_filesystem_snapshots s
     SET scan_path = COALESCE(
       NULLIF(s.raw_payload->>'path', ''),
       CASE WHEN d.os_type = 'windows' THEN 'C:\' ELSE '/' END
     )
    FROM devices d
   WHERE d.id = s.device_id
     AND s.scan_path IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'filesystem scan_path contraction: repaired % snapshot rows W02 left NULL', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  -- Scan state carries no raw payload to recover a path from, and relabelling
  -- a row as the OS root can resume a D:\ checkpoint into C:\ (spec §13 #8).
  -- W02 owns the correct backfill; anything still NULL here is a row W02 could
  -- not attribute, so its resumable state is cleared rather than guessed.
  UPDATE device_filesystem_scan_state st
     SET scan_path = CASE WHEN d.os_type = 'windows' THEN 'C:\' ELSE '/' END,
         checkpoint = '{}'::jsonb,
         aggregate = '{}'::jsonb,
         hot_directories = '[]'::jsonb
    FROM devices d
   WHERE d.id = st.device_id
     AND st.scan_path IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'filesystem scan_path contraction: cleared resumable state on % scan-state rows W02 left NULL', n;
END $$;

ALTER TABLE device_filesystem_snapshots ALTER COLUMN scan_path SET NOT NULL;
ALTER TABLE device_filesystem_scan_state ALTER COLUMN scan_path SET NOT NULL;

-- W02 already dropped the single-column primary key to allow multiple
-- volumes per device. Promote its unique index rather than expecting the old
-- key to exist. PostgreSQL renames the index to the constraint name, so no
-- redundant interim index remains. On replay the primary key already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'device_filesystem_scan_state'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE device_filesystem_scan_state
      ADD CONSTRAINT device_filesystem_scan_state_pkey
      PRIMARY KEY USING INDEX device_filesystem_scan_state_device_path_uidx;
  END IF;
END $$;
