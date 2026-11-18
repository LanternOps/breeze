SELECT set_config('breeze.scope', 'system', true);

-- #10531: retain the event's org for erasure, merge and metadata export.
-- webhook_deliveries carries no partner-export material triggers, so this
-- backfill needs no partner-export pre-locks. Fillable rows only, in 10k batches.
DO $$
DECLARE
  n bigint;
  total bigint := 0;
BEGIN
  LOOP
    UPDATE webhook_deliveries d SET org_id = w.org_id
      FROM webhooks w
     WHERE w.id = d.webhook_id
       AND d.ctid IN (
         SELECT pending.ctid FROM webhook_deliveries pending
          JOIN webhooks owner ON owner.id = pending.webhook_id
         WHERE pending.org_id IS NULL AND owner.org_id IS NOT NULL
         LIMIT 10000
       );
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXIT WHEN n = 0;
  END LOOP;
  IF total > 0 THEN
    RAISE WARNING 'backfilled % webhook_deliveries.org_id', total;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_deliveries_org_id_chk' AND conrelid = 'webhook_deliveries'::regclass) THEN
    ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_org_id_chk
      CHECK (org_id IS NOT NULL OR event_id LIKE 'test-%') NOT VALID;
  END IF;
END $$;
ALTER TABLE webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_org_id_chk;
