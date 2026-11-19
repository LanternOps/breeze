-- Portal registration W5 (#11382): domain verification on customer_email_domains
-- (spec §5.4, plan D1–D4). DDL only; system scope first per migrations/README.
-- autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.customer_email_domains
  ADD COLUMN IF NOT EXISTS verification_token text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_method text,
  ADD COLUMN IF NOT EXISTS verified_evidence jsonb,
  ADD COLUMN IF NOT EXISTS verified_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_passed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_status text,
  ADD COLUMN IF NOT EXISTS check_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleared_reason text;

DO $$
DECLARE t regclass := 'public.customer_email_domains'::regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_verified_method_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_verified_method_chk
      CHECK (verified_method IS NULL OR verified_method IN ('dns_txt','entra_tenant','google_directory'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_verification_shape_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_verification_shape_chk
      CHECK ((verified_at IS NULL) = (verified_method IS NULL)
         AND (verified_at IS NULL) = (verified_evidence IS NULL)
         AND (verified_at IS NULL) = (last_passed_at IS NULL));
  END IF;
  -- evidence.via must equal the method and the evidence must be an object
  -- (`?` on an array matches its string elements). Each CHECK owns one concern,
  -- so a bad row names the constraint it actually broke.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_evidence_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_evidence_chk
      CHECK (verified_method IS NULL
         OR verified_evidence IS NULL                                             -- verification_shape_chk owns this
         OR verified_method NOT IN ('dns_txt','entra_tenant','google_directory')  -- verified_method_chk owns this
         OR (jsonb_typeof(verified_evidence) = 'object'
             AND (verified_evidence->>'via') IS NOT DISTINCT FROM verified_method
             AND ((verified_method = 'dns_txt' AND verified_evidence ? 'recordName')
               OR (verified_method = 'entra_tenant' AND verified_evidence ? 'tenantId' AND verified_evidence ? 'connectionId')
               OR (verified_method = 'google_directory' AND verified_evidence ? 'connectionId'))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_check_status_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_check_status_chk
      CHECK ((last_check_status IS NULL OR last_check_status IN ('pass','fail','unavailable')) AND check_failures >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_cleared_shape_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_cleared_shape_chk
      CHECK ((cleared_at IS NULL) = (cleared_reason IS NULL)
         AND (cleared_at IS NULL OR verified_at IS NULL)
         AND (cleared_reason IS NULL OR cleared_reason IN
              ('record_missing','not_in_directory','tenant_not_proven','connection_missing','stale','repointed','msp_removed','displaced')));
  END IF;
END $$;

-- D4: a domain is verified for at most one org, platform-wide (crosses partners;
-- RLS does not apply to uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS customer_email_domains_verified_domain_uq
  ON public.customer_email_domains (lower(domain)) WHERE verified_at IS NOT NULL;

-- D3 / inv. 3: a proof is about ONE org and ONE domain. Any writer that repoints
-- the row (ticket-config PATCH, the AI tool, a future writer) drops it and
-- rotates the DNS token. Org merge sets breeze.org_merge=on for its single
-- Phase B transaction (services/orgMerge.ts) and is exempt.
CREATE OR REPLACE FUNCTION public.customer_email_domains_clear_verification_on_repoint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.org_id IS DISTINCT FROM OLD.org_id OR lower(NEW.domain) IS DISTINCT FROM lower(OLD.domain))
     AND coalesce(current_setting('breeze.org_merge', true), '') <> 'on' THEN
    IF OLD.verified_at IS NOT NULL THEN
      NEW.cleared_at := now(); NEW.cleared_reason := 'repointed';
    ELSE
      -- an old org's "verification lost" note must not follow the row to a new org
      NEW.cleared_at := NULL; NEW.cleared_reason := NULL;
    END IF;
    NEW.verification_token := NULL;
    NEW.verified_at := NULL; NEW.verified_method := NULL; NEW.verified_evidence := NULL;
    NEW.verified_by_user_id := NULL; NEW.last_passed_at := NULL;
    NEW.last_check_status := NULL; NEW.check_failures := 0;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS customer_email_domains_clear_verification_on_repoint ON public.customer_email_domains;
CREATE TRIGGER customer_email_domains_clear_verification_on_repoint
  BEFORE UPDATE ON public.customer_email_domains
  FOR EACH ROW EXECUTE FUNCTION public.customer_email_domains_clear_verification_on_repoint();
