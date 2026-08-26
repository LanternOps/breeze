-- AI agents wave 3.5a (#3825): one webhook delivery per (webhook, event).
--
-- webhook_deliveries has carried an event_id column since the baseline but no
-- uniqueness on it, and BEFORE this migration the '*' event subscriber in
-- workers/webhookDelivery.ts created a delivery row and queued an outbound POST
-- unconditionally. A redelivered event therefore produced a SECOND POST to the
-- CUSTOMER's endpoint — the only externally-visible duplicate in the wave-3.5
-- idempotency audit, and the one that cannot be walked back once it has been
-- sent.
--
-- Today delivery is in-process and at-most-once, so this is latent. Wave 3.5c
-- moves dispatch onto a durable queue (at-least-once) and wave 3.5d splits the
-- worker into its own container; this index is what makes that safe.

-- Pre-existing duplicates must go before the unique index can be created.
-- Keep the FIRST row per pair — deterministic (created_at ASC, id ASC), not
-- because it is necessarily the row that delivered — and report the count.
-- Silently discarding delivery history destroys the forensic trail, and a
-- non-zero count here is itself evidence that duplicate delivery already
-- happens in production.
DO $$
DECLARE
  removed integer;
BEGIN
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY webhook_id, event_id ORDER BY created_at ASC, id ASC
    ) AS rn
    FROM webhook_deliveries
  )
  DELETE FROM webhook_deliveries wd
  USING ranked
  WHERE wd.id = ranked.id AND ranked.rn > 1;

  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE WARNING 'wave 3.5a: removed % duplicate webhook_deliveries row(s)', removed;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_webhook_event_uq
  ON webhook_deliveries (webhook_id, event_id);
