SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS org_autopay_enrollments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 partner_id uuid NOT NULL REFERENCES partners(id),
 status autopay_enrollment_status NOT NULL DEFAULT 'requested',
 generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
 stripe_connection_id uuid NOT NULL,
 stripe_account_id text NOT NULL,
 stripe_customer_id text,
 effective_from timestamptz,
 requested_by uuid,
 requested_at timestamptz,
 request_recipient_email text,
 paused_by uuid,
 paused_at timestamptz,
 cancelled_at timestamptz,
 cancel_source text CHECK (cancel_source IN ('client','msp','system')),
 cancel_reason text,
 needs_attention_reason text CHECK (needs_attention_reason IN ('method_unusable','stripe_account_changed','key_missing_permissions','verification_failed')),
 CONSTRAINT org_autopay_enrollments_org_id_unique UNIQUE (org_id), CONSTRAINT org_autopay_enrollments_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT org_autopay_enrollments_org_partner_fk FOREIGN KEY (org_id,partner_id) REFERENCES organizations(id,partner_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT org_autopay_enrollments_connection_partner_fk FOREIGN KEY (stripe_connection_id,partner_id) REFERENCES stripe_connect_accounts(id,partner_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE IF NOT EXISTS org_payment_methods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL,
 stripe_payment_method_id text NOT NULL,
 type text NOT NULL CHECK (type IN ('card','us_bank_account')),
 card_brand text,
 card_last4 text,
 card_exp_month integer CHECK (card_exp_month BETWEEN 1 AND 12),
 card_exp_year integer,
 card_funding text CHECK (card_funding IN ('credit','debit','prepaid','unknown')),
 card_country text,
 bank_name text,
 bank_last4 text,
 account_holder_type text CHECK (account_holder_type IN ('individual','company')),
 stripe_mandate_id text,
 stripe_setup_intent_id text,
 status org_payment_method_status NOT NULL DEFAULT 'pending_verification',
 unusable_reason text,
 is_autopay_method boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 removed_at timestamptz,
 CONSTRAINT org_payment_methods_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT org_payment_methods_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS org_payment_methods_autopay_uq ON org_payment_methods(org_id) WHERE is_autopay_method AND status IN ('active','pending_verification');
CREATE TABLE IF NOT EXISTS org_autopay_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL,
 generation integer NOT NULL CHECK (generation > 0),
 payment_method_id uuid NOT NULL,
 consent_text_version text NOT NULL,
 consent_text_hash text NOT NULL,
 fee_terms jsonb NOT NULL,
 schedule_terms jsonb NOT NULL,
 contact_email text NOT NULL,
 ip text,
 user_agent text,
 source text NOT NULL CHECK (source IN ('setup_page','pay_and_save','portal')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT org_autopay_consents_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT org_autopay_consents_method_org_fk FOREIGN KEY (payment_method_id,org_id) REFERENCES org_payment_methods(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
ALTER TABLE org_autopay_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_autopay_enrollments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON org_autopay_enrollments;
CREATE POLICY breeze_autopay_tenant ON org_autopay_enrollments FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON org_autopay_enrollments TO breeze_app;
ALTER TABLE org_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_payment_methods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON org_payment_methods;
CREATE POLICY breeze_autopay_tenant ON org_payment_methods FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON org_payment_methods TO breeze_app;
ALTER TABLE org_autopay_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_autopay_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON org_autopay_consents;
CREATE POLICY breeze_autopay_tenant ON org_autopay_consents FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON org_autopay_consents TO breeze_app;
REVOKE UPDATE,DELETE,TRUNCATE ON org_autopay_consents FROM breeze_app,PUBLIC;
GRANT SELECT,DELETE ON org_autopay_consents TO breeze_audit_admin;
REVOKE INSERT,UPDATE,TRUNCATE ON org_autopay_consents FROM breeze_audit_admin;
CREATE OR REPLACE FUNCTION org_autopay_consents_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='breeze_audit_admin' AND current_setting('breeze.allow_audit_retention',true)='1' THEN RETURN OLD; END IF;
 RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='autopay consents are append-only';
END $$;
DROP TRIGGER IF EXISTS org_autopay_consents_immutable ON org_autopay_consents;
CREATE TRIGGER org_autopay_consents_immutable BEFORE UPDATE OR DELETE ON org_autopay_consents FOR EACH ROW EXECUTE FUNCTION org_autopay_consents_immutable();
