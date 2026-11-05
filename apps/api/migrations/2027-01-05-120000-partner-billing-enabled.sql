-- Partner billing toggle (`partners.billing_enabled`), PR 1: column + backfill.
-- Spec: docs/superpowers/specs/billing/2026-10-16-partner-billing-enabled-design.md
-- §5 (migration order), §5.4 (system scope), §5.6 (column, not settings JSONB).
--
-- Order matters so that a re-run keeps an admin's change:
--   1. add the column NULLABLE;
--   2. backfill ONLY rows where it is still NULL;
--   3. SET DEFAULT true, then SET NOT NULL.
-- After the first apply no row is NULL, so a re-apply backfills nothing and
-- never overwrites a value an admin changed.
--
-- Backfill (spec §5.2): true when the partner runs native service management
-- OR has live billing (an active contract, an open receivable, or an autopay
-- enrolment that is not cancelled); false for every other partner. Soft-deleted
-- partners are included uniformly.
--
-- Tenancy: partners has no org_id (partner-axis), so no cascade/export entry.

SET LOCAL lock_timeout = '5s';

-- partners, contracts, invoices and org_autopay_enrollments are all FORCE ROW
-- LEVEL SECURITY. Without system scope the EXISTS subselects below see ZERO
-- rows on a non-bypass connection and every partner silently becomes false.
-- Must come BEFORE the first DML. (#4518)
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_enabled boolean;

DO $$
DECLARE
  n_total bigint;
  n_true bigint;
  n_false bigint;
BEGIN
  UPDATE partners p
  SET billing_enabled = (
    p.service_management_mode = 'native'
    OR EXISTS (
      SELECT 1 FROM contracts c
      WHERE c.partner_id = p.id AND c.status = 'active'
    )
    -- Open receivable: mirrors AR_OPEN_STATUSES in
    -- apps/api/src/db/schema/invoices.ts ('sent','partially_paid','overdue').
    OR EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.partner_id = p.id AND i.status IN ('sent', 'partially_paid', 'overdue')
    )
    OR EXISTS (
      SELECT 1 FROM org_autopay_enrollments e
      WHERE e.partner_id = p.id AND e.status <> 'cancelled'
    )
  )
  WHERE p.billing_enabled IS NULL;
  GET DIAGNOSTICS n_total = ROW_COUNT;

  IF n_total > 0 THEN
    SELECT count(*) FILTER (WHERE billing_enabled), count(*) FILTER (WHERE NOT billing_enabled)
      INTO n_true, n_false FROM partners;
    RAISE WARNING 'partners.billing_enabled backfilled % partners (table now: % true, % false)',
      n_total, n_true, n_false;
  END IF;
END $$;

ALTER TABLE partners ALTER COLUMN billing_enabled SET DEFAULT true;
ALTER TABLE partners ALTER COLUMN billing_enabled SET NOT NULL;
