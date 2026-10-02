SELECT set_config('breeze.scope','system',true);
ALTER TYPE billing_notice_status ADD VALUE IF NOT EXISTS 'handler_failed';
CREATE TABLE IF NOT EXISTS billing_notice_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid,
 enrollment_id uuid,
 kind billing_notice_kind NOT NULL,
 seq integer NOT NULL CHECK (seq >= 0),
 dedupe_key text NOT NULL,
 to_email text NOT NULL,
 rendered jsonb NOT NULL,
 status billing_notice_status NOT NULL DEFAULT 'pending',
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 provider_message_id text,
 last_error text,
 CONSTRAINT billing_notice_outbox_dedupe_key_unique UNIQUE (dedupe_key), CONSTRAINT billing_notice_outbox_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT billing_notice_outbox_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT billing_notice_outbox_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS billing_notice_outbox_dispatch_idx ON billing_notice_outbox(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS billing_link_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 purpose billing_link_purpose NOT NULL,
 token_hash text NOT NULL,
 token_ct text NOT NULL,
 enrollment_id uuid,
 invoice_id uuid,
 generation integer CHECK (generation > 0),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 revoked_at timestamptz,
 CONSTRAINT billing_link_tokens_invoice_chk CHECK (purpose NOT IN ('skip_invoice','confirm_payment') OR invoice_id IS NOT NULL),
 CONSTRAINT billing_link_tokens_enrollment_chk CHECK (purpose NOT IN ('enroll','stop_autopay') OR enrollment_id IS NOT NULL),
 CONSTRAINT billing_link_tokens_token_hash_unique UNIQUE (token_hash),
 CONSTRAINT billing_link_tokens_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT billing_link_tokens_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invoice_autopay_schedules_notice_org_fk') THEN
  ALTER TABLE invoice_autopay_schedules ADD CONSTRAINT invoice_autopay_schedules_notice_org_fk FOREIGN KEY (notice_outbox_id,org_id) REFERENCES billing_notice_outbox(id,org_id) DEFERRABLE INITIALLY IMMEDIATE;
 END IF;
END $$;
ALTER TABLE billing_notice_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_notice_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON billing_notice_outbox;
CREATE POLICY breeze_autopay_tenant ON billing_notice_outbox FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON billing_notice_outbox TO breeze_app;
ALTER TABLE billing_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_link_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON billing_link_tokens;
CREATE POLICY breeze_autopay_tenant ON billing_link_tokens FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON billing_link_tokens TO breeze_app;
