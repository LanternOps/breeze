-- #4617 spec §4.1: ticket approval policy. Dual-axis config (org XOR partner):
-- one partner-default row and at most one org-override row; a NULL column means
-- inherit. Read ONLY through resolveTicketApprovalSettings
-- (services/ticketApproval/settings.ts).
-- Template: 2026-12-03-110100-billing-payment-settings.sql.
SELECT set_config('breeze.scope', 'system', true);

CREATE TABLE IF NOT EXISTS ticket_approval_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  enabled boolean,
  budget_trigger boolean,
  after_hours_trigger boolean,
  enforcement text CHECK (enforcement IN ('soft', 'hard')),
  request_ttl_hours integer CHECK (request_ttl_hours BETWEEN 1 AND 720),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_approval_settings_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_approval_settings_partner_uq
  ON ticket_approval_settings (partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_approval_settings_org_uq
  ON ticket_approval_settings (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE ticket_approval_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_approval_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_approval_settings_tenant ON ticket_approval_settings;
CREATE POLICY ticket_approval_settings_tenant ON ticket_approval_settings FOR ALL
  USING (current_setting('breeze.scope', true) = 'system'
         OR public.breeze_has_org_access(org_id)
         OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (current_setting('breeze.scope', true) = 'system'
              OR public.breeze_has_org_access(org_id)
              OR public.breeze_has_partner_access(partner_id));
-- Additive SELECT-only branch so an org-scoped context can read its partner's
-- default row (CLAUDE.md partner-wide playbook step 3). Never folded into the
-- FOR ALL policy: that would widen UPDATE/DELETE targeting to partner rows.
DROP POLICY IF EXISTS ticket_approval_settings_partner_default_select ON ticket_approval_settings;
CREATE POLICY ticket_approval_settings_partner_default_select ON ticket_approval_settings FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ticket_approval_settings TO breeze_app;
