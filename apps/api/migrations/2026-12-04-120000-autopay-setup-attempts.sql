SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS autopay_setup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigserial NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  token_id uuid,
  source text NOT NULL CHECK(source IN ('setup_page','pay_and_save','portal')),
  method_type text NOT NULL CHECK(method_type IN ('card','us_bank_account')),
  stripe_connection_id uuid NOT NULL,
  stripe_account_id text NOT NULL,
  stripe_customer_id text,
  checkout_session_id text,
  setup_intent_id text,
  payment_intent_id text,
  consent_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text CHECK(outcome IN ('activated','pending_verification','stale_generation','failed','in_progress','abandoned')),
  CONSTRAINT autopay_setup_attempts_enrollment_org_fk FOREIGN KEY(enrollment_id,org_id)
    REFERENCES org_autopay_enrollments(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT autopay_setup_attempts_org_partner_fk FOREIGN KEY(org_id,partner_id)
    REFERENCES organizations(id,partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS autopay_setup_attempts_checkout_uq
  ON autopay_setup_attempts(stripe_account_id,checkout_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS autopay_setup_attempts_setup_intent_uq
  ON autopay_setup_attempts(stripe_account_id,setup_intent_id);
CREATE INDEX IF NOT EXISTS autopay_setup_attempts_unfinished_idx
  ON autopay_setup_attempts(created_at) WHERE completed_at IS NULL;
ALTER TABLE autopay_setup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopay_setup_attempts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND tablename='autopay_setup_attempts' AND policyname='autopay_setup_attempts_tenant') THEN
  CREATE POLICY autopay_setup_attempts_tenant ON autopay_setup_attempts
   USING (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id))
   WITH CHECK (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id));
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON autopay_setup_attempts TO breeze_app;
GRANT USAGE,SELECT ON SEQUENCE autopay_setup_attempts_ordinal_seq TO breeze_app;
CREATE OR REPLACE FUNCTION autopay_setup_attempts_immutable_authority() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.ordinal,NEW.org_id,NEW.partner_id,NEW.enrollment_id,NEW.generation,NEW.token_id,
   NEW.source,NEW.method_type,NEW.stripe_connection_id,NEW.stripe_account_id,
   NEW.consent_snapshot,NEW.created_at) IS DISTINCT FROM
   ROW(OLD.ordinal,OLD.org_id,OLD.partner_id,OLD.enrollment_id,OLD.generation,OLD.token_id,
   OLD.source,OLD.method_type,OLD.stripe_connection_id,OLD.stripe_account_id,
   OLD.consent_snapshot,OLD.created_at) THEN
   RAISE EXCEPTION 'autopay setup authority is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS autopay_setup_attempts_immutable_authority ON autopay_setup_attempts;
CREATE TRIGGER autopay_setup_attempts_immutable_authority BEFORE UPDATE ON autopay_setup_attempts
 FOR EACH ROW EXECUTE FUNCTION autopay_setup_attempts_immutable_authority();

ALTER TABLE autopay_setup_attempts DROP CONSTRAINT IF EXISTS autopay_setup_attempts_outcome_check;
ALTER TABLE autopay_setup_attempts ADD CONSTRAINT autopay_setup_attempts_outcome_check
 CHECK(outcome IN ('activated','pending_verification','stale_generation','failed','in_progress','abandoned'));
