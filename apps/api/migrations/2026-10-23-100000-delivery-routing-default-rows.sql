-- W05b (alerting consolidation): explicit "Everything else" routing rows replace
-- the dispatcher's hidden all-enabled-channels fallback.
-- Spec: docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md
--       §Data model "Routing", §Delivery resolution "Migration".
--
-- SYSTEM SCOPE IS ELECTED FIRST AND IT IS LOAD-BEARING. notification_routing_rules
-- is FORCE ROW LEVEL SECURITY with one FOR ALL policy
-- (2026-07-01-notification-rails-partner-ownership.sql). Without this line the
-- count SELECT reads zero rows and the INSERTs abort with 42501. `is_local => true`
-- scopes it to autoMigrate's per-file transaction. Enforced by
-- apps/api/src/db/migrationRlsScope.test.ts.
--
-- The two INSERTs reproduce EXACTLY the fallback query the dispatcher ran on
-- main@b8dd148bd8 (notificationDispatcher.ts:362-371): railOwnershipCondition
-- (org_id = O OR (org_id IS NULL AND partner_id = O.partner_id)) AND enabled = true.
-- Day one is behavior-identical; from then on a new channel is opt-in.
--
-- Idempotent: IF NOT EXISTS everywhere, NOT EXISTS guards on both INSERTs.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file). Counts RAISE WARNING so
-- they land in Postgres logs (log_min_messages defaults to warning).

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE notification_routing_rules
  ADD COLUMN IF NOT EXISTS escalation_policy_id uuid REFERENCES escalation_policies(id) ON DELETE SET NULL;
ALTER TABLE notification_routing_rules
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. One "Everything else" row per axis.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_rules_org_default_uidx
  ON notification_routing_rules (org_id)
  WHERE is_default AND partner_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_rules_partner_default_uidx
  ON notification_routing_rules (partner_id)
  WHERE is_default AND org_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Report rows still carrying the never-evaluated keys. Left as-is: the
--    resolver ignores unknown keys and the API now rejects them on write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM notification_routing_rules
   WHERE conditions ? 'conditionTypes' OR conditions ? 'deviceTags';
  IF n > 0 THEN
    RAISE WARNING 'notification_routing_rules: % row(s) carry conditionTypes/deviceTags (never evaluated; left in place)', n;
  ELSE
    RAISE NOTICE 'notification_routing_rules: no rows carry conditionTypes/deviceTags';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Partner rows: every partner with >= 1 ENABLED partner-wide channel.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  INSERT INTO notification_routing_rules
    (org_id, partner_id, name, priority, conditions, channel_ids, enabled, is_default)
  SELECT NULL, c.partner_id, 'Everything else', 1000000, '{}'::jsonb,
         jsonb_agg(c.id::text ORDER BY c.created_at, c.id), true, true
    FROM notification_channels c
   WHERE c.org_id IS NULL
     AND c.partner_id IS NOT NULL
     AND c.enabled = true
     AND NOT EXISTS (
       SELECT 1 FROM notification_routing_rules r
        WHERE r.partner_id = c.partner_id AND r.org_id IS NULL AND r.is_default
     )
   GROUP BY c.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'delivery default rows: inserted % partner "Everything else" row(s)', n;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Org rows: every org with >= 1 ENABLED org-owned channel. Channel set =
--    org's enabled channels + its partner's enabled partner-wide channels —
--    the exact old fallback. Orgs with no org-owned channel get no row: the
--    partner row already yields the identical set for them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  INSERT INTO notification_routing_rules
    (org_id, partner_id, name, priority, conditions, channel_ids, enabled, is_default)
  SELECT o.id, NULL, 'Everything else', 1000000, '{}'::jsonb,
         (
           SELECT jsonb_agg(c.id::text ORDER BY (c.org_id IS NULL), c.created_at, c.id)
             FROM notification_channels c
            WHERE c.enabled = true
              AND (c.org_id = o.id OR (c.org_id IS NULL AND c.partner_id = o.partner_id))
         ),
         true, true
    FROM organizations o
   WHERE EXISTS (
           SELECT 1 FROM notification_channels oc
            WHERE oc.org_id = o.id AND oc.enabled = true
         )
     AND NOT EXISTS (
           SELECT 1 FROM notification_routing_rules r
            WHERE r.org_id = o.id AND r.is_default
         );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'delivery default rows: inserted % org "Everything else" row(s)', n;
END $$;
