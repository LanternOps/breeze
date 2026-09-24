SELECT set_config('breeze.scope', 'system', true);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS subject_key text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'alerts'::regclass AND conname = 'alerts_subject_key_nonempty_chk'
  ) THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_subject_key_nonempty_chk CHECK (subject_key <> '');
  END IF;
END $$;
DO $$
DECLARE n integer;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY rule_id, device_id ORDER BY triggered_at DESC, id DESC
    ) AS position
    FROM alerts
    WHERE rule_id IS NOT NULL AND subject_key IS NULL
      AND status IN ('active', 'acknowledged', 'suppressed')
  )
  UPDATE alerts a
  SET status = 'resolved', resolved_at = now(), resolution_note = 'deduplicated by migration'
  FROM ranked r WHERE a.id = r.id AND r.position > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'resolved % duplicate open alerts', n;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_rule_device_subject_uidx
  ON alerts (rule_id, device_id, COALESCE(subject_key, ''))
  WHERE rule_id IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed');
