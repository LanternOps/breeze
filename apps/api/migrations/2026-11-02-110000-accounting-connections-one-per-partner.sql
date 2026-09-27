-- Xero W01 (spec D2): one accounting connection per partner, DB-enforced.
--
-- ADDS accounting_connections_partner_idx (partner_id) and deliberately KEEPS
-- accounting_connections_partner_provider_idx (partner_id, provider): the
-- previous image's upsertConnection uses ON CONFLICT (partner_id, provider),
-- which needs an index matching that target exactly. Dropping it would break
-- every QuickBooks reconnect on a rollback or during a rolling restart. It is
-- redundant (unique partner_id implies unique (partner_id, provider)); drop it
-- in a later release once W01 can no longer be rolled back.
--
-- Idempotent: the precheck is read-only and the index uses IF NOT EXISTS.

DO $$
DECLARE
  dup_partners integer;
BEGIN
  -- accounting_connections is FORCE ROW LEVEL SECURITY and migrations run as the
  -- table owner under breeze.scope='none', which sees ZERO rows. Without this the
  -- count below is always 0 and the precheck proves nothing.
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO dup_partners
  FROM (
    SELECT partner_id
    FROM accounting_connections
    GROUP BY partner_id
    HAVING count(*) > 1
  ) d;

  IF dup_partners > 0 THEN
    RAISE WARNING 'accounting_connections: % partner(s) hold more than one connection row', dup_partners;
    RAISE EXCEPTION 'accounting_connections one-per-partner precondition failed: % partner(s) have more than one row; resolve by hand (disconnect the extra provider) before deploying', dup_partners;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_partner_idx
  ON accounting_connections (partner_id);
