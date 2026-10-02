SELECT set_config('breeze.scope','system',true);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_stripe_payments_id_org_uq ON invoice_stripe_payments(id,org_id);
CREATE TABLE IF NOT EXISTS invoice_autopay_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid NOT NULL,
 enrollment_id uuid,
 enrollment_generation integer NOT NULL,
 eligible boolean NOT NULL,
 ineligible_reason text CHECK (ineligible_reason IN ('not_enrolled','enrolled_after_issue','method_not_usable','over_cap','cap_currency_mismatch','ach_currency_unsupported','excluded_contract','excluded_invoice','charging_disabled','stripe_unavailable')),
 collect_on date,
 terms_snapshot jsonb NOT NULL,
 notice_outbox_id uuid,
 notice_sent_at timestamptz,
 state autopay_schedule_state NOT NULL DEFAULT 'awaiting_notice',
 state_reason text,
 next_attempt_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
 client_skipped_at timestamptz,
 msp_excluded_by uuid,
 msp_excluded_at timestamptz,
 CONSTRAINT invoice_autopay_schedules_eligible_chk CHECK (eligible = (ineligible_reason IS NULL)),
 CONSTRAINT invoice_autopay_schedules_collect_on_chk CHECK (state NOT IN ('scheduled','retry_scheduled') OR collect_on IS NOT NULL),
 CONSTRAINT invoice_autopay_schedules_invoice_id_unique UNIQUE (invoice_id), CONSTRAINT invoice_autopay_schedules_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT invoice_autopay_schedules_authority_chk CHECK (enrollment_id IS NOT NULL OR state IN ('succeeded','failed','skipped_by_client','excluded_by_msp','cancelled','not_needed')),
 CONSTRAINT invoice_autopay_schedules_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_autopay_schedules_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS invoice_autopay_schedules_due_idx ON invoice_autopay_schedules(state,collect_on,next_attempt_at);
CREATE TABLE IF NOT EXISTS invoice_collection_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid NOT NULL,
 schedule_id uuid,
 attempt_no integer NOT NULL CHECK (attempt_no > 0),
 payment_method_id uuid,
 stripe_payment_intent_id text,
 idempotency_key text NOT NULL,
 principal_amount numeric(12,2) NOT NULL CHECK (principal_amount > 0),
 fee_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
 currency char(3) NOT NULL CONSTRAINT invoice_collection_attempts_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
 state collection_attempt_state NOT NULL DEFAULT 'reserved',
 failure_code text,
 decline_code text,
 failure_class text CHECK (failure_class IN ('soft','hard','auth_required','nsf','revoked')),
 invoice_stripe_payment_id uuid,
 initiated_by text NOT NULL CHECK (initiated_by IN ('scheduler','msp_charge_now','client_on_session')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT invoice_collection_attempts_idempotency_key_unique UNIQUE (idempotency_key), CONSTRAINT invoice_collection_attempts_stripe_payment_intent_id_unique UNIQUE (stripe_payment_intent_id), CONSTRAINT invoice_collection_attempts_schedule_id_attempt_no_unique UNIQUE (schedule_id,attempt_no),
 CONSTRAINT invoice_collection_attempts_schedule_chk CHECK (schedule_id IS NOT NULL OR initiated_by='client_on_session'),
 CONSTRAINT invoice_collection_attempts_authority_chk CHECK (payment_method_id IS NOT NULL OR state IN ('succeeded','failed','canceled','unapplied')),
 CONSTRAINT invoice_collection_attempts_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_collection_attempts_schedule_org_fk FOREIGN KEY (schedule_id,org_id) REFERENCES invoice_autopay_schedules(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_collection_attempts_method_org_fk FOREIGN KEY (payment_method_id,org_id) REFERENCES org_payment_methods(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_collection_attempts_mapping_org_fk FOREIGN KEY (invoice_stripe_payment_id,org_id) REFERENCES invoice_stripe_payments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS invoice_collection_attempts_active_idx ON invoice_collection_attempts(invoice_id,state) WHERE state IN ('reserved','created','confirming','processing','requires_action');
ALTER TABLE invoice_autopay_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_autopay_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON invoice_autopay_schedules;
CREATE POLICY breeze_autopay_tenant ON invoice_autopay_schedules FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON invoice_autopay_schedules TO breeze_app;
ALTER TABLE invoice_collection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_collection_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON invoice_collection_attempts;
CREATE POLICY breeze_autopay_tenant ON invoice_collection_attempts FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON invoice_collection_attempts TO breeze_app;
