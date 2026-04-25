ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS mcp_origin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mcp_origin_ip INET,
  ADD COLUMN IF NOT EXISTS mcp_origin_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_method_attached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE TABLE IF NOT EXISTS partner_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_activations_partner ON partner_activations(partner_id);

ALTER TABLE partner_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_activations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'partner_activations_partner_access') THEN
    CREATE POLICY partner_activations_partner_access ON partner_activations
      USING (breeze_has_partner_access(partner_id))
      WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
END $$;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scope_state TEXT NOT NULL DEFAULT 'full'
    CHECK (scope_state IN ('readonly', 'full'));

CREATE TABLE IF NOT EXISTS deployment_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enrollment_key_id UUID NOT NULL REFERENCES enrollment_keys(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_by_api_key_id UUID REFERENCES api_keys(id),
  custom_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  clicked_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ,
  device_id UUID REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'clicked', 'enrolled', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_deployment_invites_partner ON deployment_invites(partner_id);
CREATE INDEX IF NOT EXISTS idx_deployment_invites_email ON deployment_invites(partner_id, invited_email);

ALTER TABLE deployment_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_invites FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deployment_invites_partner_access') THEN
    CREATE POLICY deployment_invites_partner_access ON deployment_invites
      USING (breeze_has_partner_access(partner_id))
      WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
END $$;
