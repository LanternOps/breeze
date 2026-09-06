-- Partner trust shadow acceptance report (last 7 days).
-- Acceptance rule (spec §5 step 3): every denial on an account later suspended;
-- zero denials on accounts still active and paying after 14 days that did not
-- also press Request review.
-- Run from the repository root (the SET and report share one psql session):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET breeze.scope = 'system'" -f apps/api/scripts/partner-trust-shadow-report.sql

WITH shadow_denials AS (
  SELECT
    a.resource_id AS partner_id,
    a.details->>'capability' AS capability
  FROM audit_logs AS a
  WHERE a.action = 'partner.trust.capability_denied'
    AND a.details->>'mode' = 'shadow'
    AND a.timestamp >= now() - interval '7 days'
)
SELECT
  p.id,
  p.name,
  p.status,
  p.created_at,
  p.trust_state,
  d.capability,
  count(*) AS shadow_denials,
  (p.status = 'suspended') AS now_suspended
FROM shadow_denials AS d
JOIN partners AS p ON p.id = d.partner_id
GROUP BY p.id, p.name, p.status, p.created_at, p.trust_state, d.capability
ORDER BY shadow_denials DESC, p.created_at, p.id, d.capability;

WITH shadow_denials AS (
  SELECT a.resource_id AS partner_id
  FROM audit_logs AS a
  WHERE a.action = 'partner.trust.capability_denied'
    AND a.details->>'mode' = 'shadow'
    AND a.timestamp >= now() - interval '7 days'
), classified AS (
  SELECT
    d.partner_id,
    CASE
      WHEN p.status = 'suspended' THEN 'partners_later_suspended'
      WHEN p.status = 'active'
        AND p.billing_subscription_status = 'active'
        AND p.created_at < now() - interval '14 days'
        AND NOT EXISTS (
          SELECT 1
          FROM audit_logs AS review
          WHERE review.action = 'partner.trust.review_requested'
            AND review.resource_id = p.id
        )
        THEN 'partners_still_active_paying_no_review'
      ELSE 'other'
    END AS outcome
  FROM shadow_denials AS d
  JOIN partners AS p ON p.id = d.partner_id
), expected_outcomes(outcome) AS (
  VALUES
    ('partners_later_suspended'::text),
    ('partners_still_active_paying_no_review'::text)
)
SELECT
  expected.outcome,
  count(classified.partner_id) AS shadow_denials,
  count(DISTINCT classified.partner_id) AS partners
FROM expected_outcomes AS expected
LEFT JOIN classified ON classified.outcome = expected.outcome
GROUP BY expected.outcome
ORDER BY expected.outcome;
