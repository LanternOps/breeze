-- Partner-owned alert delivery rails (epic #2135, issue #2130).
--
-- Until now notification_channels, notification_routing_rules, and
-- escalation_policies were always owned by exactly one org (org_id NOT NULL),
-- so even a partner-wide alert rule (#2128) could not route to the MSP's own
-- Slack/PSA/email without per-org channel setup. This migration makes each
-- rail ownable by EITHER an org (org_id set, partner_id NULL — the existing
-- shape) OR a partner (partner_id set, org_id NULL — "partner-wide / all
-- orgs"), enforced by an exactly-one-axis CHECK per table. Mirrors
-- software_policies (#2126) and automation_policies (#2129).
--
-- alert_notifications is unchanged: it has no ownership columns and reaches
-- its tenant through the alert join (alerts.org_id — always the firing
-- device's concrete org), which is correct for partner-wide rails too.
--
-- notification_channels.config is an encrypted column whose AAD is bound to
-- the table/column (encryptedColumnRegistry), NOT to the org — safe for
-- org_id NULL rows.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECKs, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- notification_channels
-- ============================================

ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE notification_channels
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notification_channels_one_owner_chk'
      AND conrelid = 'notification_channels'::regclass
  ) THEN
    ALTER TABLE notification_channels
      ADD CONSTRAINT notification_channels_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notification_channels_partner_id_idx
  ON notification_channels(partner_id);

ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_channels FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON notification_channels;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON notification_channels;
DROP POLICY IF EXISTS breeze_org_isolation_update ON notification_channels;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON notification_channels;
DROP POLICY IF EXISTS notification_channels_isolation ON notification_channels;
CREATE POLICY notification_channels_isolation
  ON notification_channels
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- notification_routing_rules
-- ============================================
-- The four breeze_org_isolation_* policies were re-issued (same names) by
-- 2026-04-11-bucket-a-rls-policies.sql; the DROPs below cover both origins.

ALTER TABLE notification_routing_rules
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE notification_routing_rules
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notification_routing_rules_one_owner_chk'
      AND conrelid = 'notification_routing_rules'::regclass
  ) THEN
    ALTER TABLE notification_routing_rules
      ADD CONSTRAINT notification_routing_rules_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notification_routing_rules_partner_id_idx
  ON notification_routing_rules(partner_id);

ALTER TABLE notification_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_routing_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON notification_routing_rules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON notification_routing_rules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON notification_routing_rules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON notification_routing_rules;
DROP POLICY IF EXISTS notification_routing_rules_isolation ON notification_routing_rules;
CREATE POLICY notification_routing_rules_isolation
  ON notification_routing_rules
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- escalation_policies
-- ============================================

ALTER TABLE escalation_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE escalation_policies
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'escalation_policies_one_owner_chk'
      AND conrelid = 'escalation_policies'::regclass
  ) THEN
    ALTER TABLE escalation_policies
      ADD CONSTRAINT escalation_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS escalation_policies_partner_id_idx
  ON escalation_policies(partner_id);

ALTER TABLE escalation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON escalation_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON escalation_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON escalation_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON escalation_policies;
DROP POLICY IF EXISTS escalation_policies_isolation ON escalation_policies;
CREATE POLICY escalation_policies_isolation
  ON escalation_policies
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
