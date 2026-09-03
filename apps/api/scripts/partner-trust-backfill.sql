-- Partner trust probation retro-backfill. Run manually per region as doadmin
-- only after PARTNER_TRUST_MODE=enforce is live.
--
-- Billing facts are service-owned, so prepare the exclusion list in the SAME
-- psql session before including this file:
--   1. Query candidates:
--        SELECT id FROM partners WHERE status = 'active'
--          AND trust_state = 'trusted'
--          AND created_at >= now() - interval '14 days';
--   2. For each candidate, query breeze-billing (a non-null JSON response is a
--      settled card charge):
--        curl -fsS -H "Authorization: Bearer $BREEZE_BILLING_API_KEY" \
--          "$BREEZE_BILLING_URL/internal/partners/<partner-id>/settled-card-charge"
--   3. In this psql session create and populate the exclusion table:
--        CREATE TEMP TABLE bf_exclude (partner_id uuid PRIMARY KEY);
--        INSERT INTO bf_exclude(partner_id) VALUES ('<partner-with-settled-card>');
--      Repeat the INSERT for every candidate whose endpoint returned a settled
--      card charge. An empty table is valid after every candidate was checked.
--   4. Run this script in that same session:
--        \i apps/api/scripts/partner-trust-backfill.sql
--
-- After running this script:
--   5. Export partner IDs to the cards script:
--        curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API/admin/trust/queue?limit=200" | \
--          jq -r '.partners[].id' | \
--          pnpm --filter @breeze/api partner-trust:backfill-cards
--      This queues evidence cards for each moved partner. Repeat with cursor
--      pagination if more than 200 partners were moved.
--
-- Dry run first: replace the final COMMIT with ROLLBACK, inspect the warning
-- count and rows, then restore COMMIT for the reviewed execution.

BEGIN;
SET LOCAL breeze.scope = 'system';

DO $$
BEGIN
  IF to_regclass('pg_temp.bf_exclude') IS NULL THEN
    RAISE EXCEPTION 'bf_exclude is required; populate it from billing endpoint results before running this script';
  END IF;
END $$;

CREATE TEMP TABLE bf ON COMMIT DROP AS
SELECT p.id
FROM partners AS p
WHERE p.status = 'active'
  AND p.trust_state = 'trusted'
  AND p.created_at >= now() - interval '14 days'
  AND NOT EXISTS (
    SELECT 1
    FROM bf_exclude AS excluded
    WHERE excluded.partner_id = p.id
  );

UPDATE partners AS p
SET
  trust_state = 'probation',
  trust_reason = 'backfill:2026-09',
  trust_changed_at = now(),
  trust_changed_by = NULL  -- system-initiated, no user actor
FROM bf
WHERE p.id = bf.id;

INSERT INTO audit_logs (
  org_id,
  actor_type,
  actor_id,
  action,
  resource_type,
  resource_id,
  details,
  result
)
SELECT
  NULL,
  'system'::actor_type,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'partner.trust.probation',
  'partner',
  bf.id,
  jsonb_build_object(
    'from', 'trusted',
    'to', 'probation',
    'reason', 'backfill:2026-09'
  ),
  'success'::audit_result
FROM bf;

DO $$
DECLARE
  moved_count integer;
BEGIN
  SELECT count(*) INTO moved_count FROM bf;
  RAISE WARNING 'partner-trust backfill moved % partners to probation', moved_count;
END $$;

COMMIT;
