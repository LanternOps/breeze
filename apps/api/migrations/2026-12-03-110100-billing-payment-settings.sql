SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS billing_payment_settings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid REFERENCES organizations(id),
 partner_id uuid REFERENCES partners(id),
 autopay_offset_days integer CHECK (autopay_offset_days BETWEEN 0 AND 60),
 autopay_offset_rule autopay_offset_rule,
 autopay_cap_enabled boolean,
 autopay_cap_amount numeric(12,2),
 autopay_cap_currency char(3),
 ach_mode ach_mode,
 card_fee_bps integer CHECK (card_fee_bps BETWEEN 0 AND 300),
 ach_fee_amount numeric(12,2) CHECK (ach_fee_amount BETWEEN 0 AND 25),
 fee_attested_by uuid REFERENCES users(id),
 fee_attested_at timestamptz,
 reminders_enabled boolean,
 reminder_before_due_days integer CHECK (reminder_before_due_days BETWEEN 1 AND 31),
 reminder_repeat_days integer CHECK (reminder_repeat_days BETWEEN 1 AND 31),
 overdue_reminder_every_days integer CHECK (overdue_reminder_every_days BETWEEN 1 AND 31),
 CONSTRAINT billing_payment_settings_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
 CONSTRAINT billing_payment_settings_cap_chk CHECK ((autopay_cap_enabled IS TRUE AND autopay_cap_amount IS NOT NULL AND autopay_cap_currency IS NOT NULL AND autopay_cap_amount > 0 AND autopay_cap_currency ~ '^[A-Z]{3}$') OR (autopay_cap_enabled IS NOT TRUE AND autopay_cap_amount IS NULL AND autopay_cap_currency IS NULL)),
 CONSTRAINT billing_payment_settings_attestation_chk CHECK ((fee_attested_by IS NULL) = (fee_attested_at IS NULL) AND (org_id IS NULL OR fee_attested_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_settings_partner_uq ON billing_payment_settings(partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_settings_org_uq ON billing_payment_settings(org_id) WHERE org_id IS NOT NULL;
ALTER TABLE billing_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payment_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON billing_payment_settings;
CREATE POLICY breeze_autopay_tenant ON billing_payment_settings FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON billing_payment_settings TO breeze_app;
DROP POLICY IF EXISTS billing_payment_settings_partner_default_select ON billing_payment_settings;
CREATE POLICY billing_payment_settings_partner_default_select ON billing_payment_settings FOR SELECT USING (org_id IS NULL AND partner_id=public.breeze_current_partner_id());
