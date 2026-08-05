-- Spec 2026-08-04: third-party ring auto-approve. Backfills the explicit
-- autoApprove.thirdPartyApps shape and migrates legacy 'third_party_app'
-- category rules to the ring-level toggle. Idempotent; counts RAISEd so the
-- rollout numbers land in Postgres logs (expected prod: 1 / 0 / 0 rows).
--
-- Statement order matters: rule conversion (1) runs BEFORE the generic
-- thirdPartyApps stamp (2), so a ring whose 3P behavior came from a category
-- rule keeps that behavior (and its deferral hold) regardless of what the
-- severity-derivation in (2) would have concluded.

DO $$
DECLARE
  n integer;
BEGIN
  -- 1) Rings with an autoApprove:true third_party_app category rule: turn on
  --    the ring-level toggle and strip the rule. Preserves intent: those rings
  --    wanted 3P auto-approved. The old category path held 3P patches for
  --    rule.deferralDaysOverride ?? the ring's deferral_days COLUMN (not the
  --    auto_approve jsonb's deferralDays), so that exact value is carried into
  --    thirdPartyDeferralDays — otherwise converted rings would silently lose
  --    their hold and auto-approve 3P updates on first sight (fail-open).
  UPDATE patch_policies p
  SET auto_approve =
        (CASE WHEN jsonb_typeof(p.auto_approve) = 'object' THEN p.auto_approve ELSE '{}'::jsonb END)
        || jsonb_build_object('enabled', true, 'thirdPartyApps', true)
        -- The pre-image's OS auto-approve state must survive this ring-level
        -- enable: if the ring wasn't already boolean-true enabled, its
        -- severities (if any) belonged to a disabled state and must not
        -- silently start applying now that 'enabled' flips to true. Compare
        -- against the jsonb boolean (not ->>'enabled' = 'true' text, which a
        -- malformed {"enabled":"true"} string row would also SATISFY,
        -- preserving severities we want cleared — the jsonb comparison
        -- correctly excludes that row so its severities are cleared too).
        || CASE WHEN p.auto_approve->'enabled' = 'true'::jsonb THEN '{}'::jsonb
                ELSE jsonb_build_object('severities', '[]'::jsonb) END
        || COALESCE(
             (SELECT CASE WHEN (r.rule->>'deferralDaysOverride') ~ '^\d{1,3}$'
                           AND (r.rule->>'deferralDaysOverride')::int <= 365
                          THEN jsonb_build_object('thirdPartyDeferralDays', (r.rule->>'deferralDaysOverride')::int)
                          -- No usable override → the old hold was the ring's
                          -- deferral_days column; carry it explicitly.
                          ELSE jsonb_build_object('thirdPartyDeferralDays', p.deferral_days) END
              FROM jsonb_array_elements(p.category_rules) AS r(rule)
              WHERE r.rule->>'category' = 'third_party_app'
                AND r.rule->>'autoApprove' = 'true'
              LIMIT 1),
             '{}'::jsonb),
      category_rules = COALESCE(
        (SELECT jsonb_agg(r.rule)
         FROM jsonb_array_elements(p.category_rules) AS r(rule)
         WHERE r.rule->>'category' IS DISTINCT FROM 'third_party_app'),
        '[]'::jsonb),
      updated_at = now()
  WHERE p.kind = 'ring'
    AND jsonb_typeof(p.category_rules) = 'array'
    AND NOT (p.auto_approve ? 'thirdPartyApps')
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.category_rules) AS r(rule)
      WHERE r.rule->>'category' = 'third_party_app'
        AND r.rule->>'autoApprove' = 'true'
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'ring-3p backfill: converted third_party_app category rules to the ring toggle on % rings', n; END IF;

  -- 2) Remaining enabled object-shaped rows lacking thirdPartyApps: derive it
  --    from whether the row has >=1 recognized severity (mirrors
  --    parseRingAutoApprove's compatibility rule / the old #2218 exemption).
  --    Rows converted by (1) already carry the key and are skipped.
  UPDATE patch_policies
  SET auto_approve = auto_approve
        || jsonb_build_object(
             'thirdPartyApps',
             EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(auto_approve->'severities') = 'array'
                      THEN auto_approve->'severities'
                      ELSE '[]'::jsonb END
               ) AS sev(v)
               WHERE sev.v IN ('critical','important','moderate','low')
             )
           )
        || CASE WHEN auto_approve ? 'thirdPartyDeferralDays'
                 THEN '{}'::jsonb
                 ELSE jsonb_build_object('thirdPartyDeferralDays', NULL::int) END
  WHERE kind = 'ring'
    AND jsonb_typeof(auto_approve) = 'object'
    AND auto_approve->>'enabled' = 'true'
    AND NOT auto_approve ? 'thirdPartyApps';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'ring-3p backfill: stamped explicit thirdPartyApps on % enabled auto_approve rows', n; END IF;

  -- 3) Strip any remaining (autoApprove:false) third_party_app rules — nothing
  --    to preserve; the category no longer exists.
  UPDATE patch_policies p
  SET category_rules = COALESCE(
        (SELECT jsonb_agg(r.rule)
         FROM jsonb_array_elements(p.category_rules) AS r(rule)
         WHERE r.rule->>'category' IS DISTINCT FROM 'third_party_app'),
        '[]'::jsonb),
      updated_at = now()
  WHERE p.kind = 'ring'
    AND jsonb_typeof(p.category_rules) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.category_rules) AS r(rule)
      WHERE r.rule->>'category' = 'third_party_app'
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'ring-3p backfill: stripped inert third_party_app rules from % rings', n; END IF;
END $$;
