-- PAM ownership epochs W1 (#8203, feature #8202): epoch-1 backfill.
--
-- Separate from 2026-12-17-130000 so that file's ACCESS EXCLUSIVE lock on
-- devices (ADD COLUMN) is released before this scans the whole table. Every
-- device gets the epoch row it would have received at enrollment, tagged
-- cause 'backfill'. Keyset batches of 5000 by device id; a device that
-- already has any epoch row (enrolled after 130000 ran) is skipped, so
-- re-applying is a no-op. Reports the row count.

SELECT set_config('breeze.scope', 'system', true);

-- devices_ownership_epoch_chk was added NOT VALID in 130000. Validating here,
-- in a separate transaction, scans devices under SHARE UPDATE EXCLUSIVE
-- (reads and writes continue) instead of under 130000's ACCESS EXCLUSIVE.
-- Re-validating an already-valid constraint is a no-op.
ALTER TABLE public.devices VALIDATE CONSTRAINT devices_ownership_epoch_chk;

DO $$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  batch_last uuid;
  batch_rows integer;
  total bigint := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    WITH batch AS (
      SELECT d.id, d.ownership_epoch, d.org_id, d.site_id
      FROM public.devices d
      WHERE d.id > last_id
      ORDER BY d.id
      LIMIT 5000
    ), ins AS (
      INSERT INTO public.device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
      SELECT b.id, b.ownership_epoch, b.org_id, b.site_id, 'backfill'
      FROM batch b
      WHERE NOT EXISTS (
        SELECT 1 FROM public.device_ownership_epochs e WHERE e.device_id = b.id
      )
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT max(id::text)::uuid FROM batch), (SELECT count(*)::int FROM ins)
      INTO batch_last, batch_rows;

    EXIT WHEN batch_last IS NULL;
    total := total + batch_rows;
    last_id := batch_last;
  END LOOP;

  IF total > 0 THEN
    RAISE WARNING 'device ownership epochs backfilled: %', total;
  ELSE
    RAISE NOTICE 'device ownership epochs backfilled: 0';
  END IF;
END $$;
