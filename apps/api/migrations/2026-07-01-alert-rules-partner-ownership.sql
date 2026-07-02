-- Partner-owned alert rules (epic #2135, issue #2128).
--
-- Until now an alert_rules row was always owned by exactly one org (org_id
-- NOT NULL), so a standalone alert pack could not be defined once and applied
-- across every org under a partner. This migration makes an alert rule ownable
-- by EITHER an org (org_id set, partner_id NULL — the existing shape) OR a
-- partner (partner_id set, org_id NULL — the "partner-wide / all orgs" shape),
-- enforced by an exactly-one-axis CHECK. Mirrors software_policies (#2126) and
-- security_policies (#2127).
--
-- Invariants for partner-wide rules (enforced app-side at the routes):
--   - targetType is always 'all' with targetId = partner_id (targetId is
--     NOT NULL; the 'all' match ignores the value)
--   - no org-scoped notification-channel/escalation bindings — dispatch falls
--     back to each firing device's OWN org routing (notificationDispatcher
--     resolves everything from alerts.org_id, which always carries the
--     device's org, never the rule's)
--
-- alerts (fired rows) stay org-only: an alert always belongs to the device's
-- org. alert_templates are already dual-ownership (2026-06-13). The
-- config-policy INLINE alert path (config_policy_alert_rules) was already
-- partner-safe via the 2026-06-27 dual-axis join policies.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE alert_rules
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE alert_rules
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'alert_rules_one_owner_chk'
      AND conrelid = 'alert_rules'::regclass
  ) THEN
    ALTER TABLE alert_rules
      ADD CONSTRAINT alert_rules_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS alert_rules_partner_id_idx
  ON alert_rules(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON alert_rules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON alert_rules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON alert_rules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON alert_rules;
DROP POLICY IF EXISTS alert_rules_isolation ON alert_rules;
CREATE POLICY alert_rules_isolation
  ON alert_rules
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
