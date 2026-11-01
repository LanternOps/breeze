SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_thread_links
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS last_touched_at timestamptz,
  ADD COLUMN IF NOT EXISTS touch_count integer;

-- Only fill missing values: replay must preserve working-set activity.
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE wisp_thread_links
     SET source = COALESCE(source, CASE WHEN added_by_grant_id IS NULL THEN 'user_pin' ELSE 'wisp_pin' END),
         last_touched_at = COALESCE(last_touched_at, created_at),
         touch_count = COALESCE(touch_count, 1)
   WHERE source IS NULL OR last_touched_at IS NULL OR touch_count IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % wisp_thread_links working-set rows', n;
END $$;

ALTER TABLE wisp_thread_links
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN last_touched_at SET DEFAULT now(),
  ALTER COLUMN last_touched_at SET NOT NULL,
  ALTER COLUMN touch_count SET DEFAULT 1,
  ALTER COLUMN touch_count SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'wisp_thread_links'::regclass
       AND conname = 'wisp_thread_links_source_chk'
  ) THEN
    ALTER TABLE wisp_thread_links ADD CONSTRAINT wisp_thread_links_source_chk
      CHECK (source IN ('user_pin','wisp_pin','auto'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wisp_thread_links_thread_touched_idx
  ON wisp_thread_links (thread_id, last_touched_at DESC);
