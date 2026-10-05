-- #7743 autopay D-17: at most one autopay-method row per organization, whatever
-- its status.
--
-- A hard-declined method stays the autopay method (status 'unusable') so the
-- enrollment can say it needs attention. Replacement retired only active and
-- pending rows, so the dead row kept is_autopay_method = true next to the new
-- one. Readers that pick "the" autopay method then read the dead card and
-- cancelled every charging notice. Replacement now retires unusable rows too;
-- this migration cleans existing data and makes the database enforce the rule.
--
-- Cleanup: per organization keep the row that is (in order) active or pending
-- verification, then newest, then highest id. Every other flagged row loses the
-- flag and becomes 'removed', which queues it for the existing Stripe detach
-- drain exactly as a replacement does. Row count is reported.
-- Idempotent: a second run finds nothing to clean, the index is IF NOT EXISTS
-- and the superseded partial index is dropped IF EXISTS.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY org_id
      ORDER BY (status IN ('active', 'pending_verification')) DESC, created_at DESC, id DESC
    ) AS rank
    FROM org_payment_methods
    WHERE is_autopay_method
  )
  UPDATE org_payment_methods m
     SET is_autopay_method = false,
         status = 'removed',
         removed_at = COALESCE(m.removed_at, now())
    FROM ranked
   WHERE ranked.id = m.id AND ranked.rank > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'retired % superseded autopay-method rows', n; END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS org_payment_methods_one_autopay_uq
  ON org_payment_methods(org_id) WHERE is_autopay_method;
-- Subsumed by the index above (it only covered active and pending rows).
DROP INDEX IF EXISTS org_payment_methods_autopay_uq;
