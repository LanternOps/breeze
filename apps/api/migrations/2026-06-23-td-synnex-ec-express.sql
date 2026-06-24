-- TD SYNNEX EC Express Price & Availability connector.
-- Partner-axis (RLS shape 3) with encrypted credential JSON. No base_url:
-- the SOAP endpoint host is server-controlled via a region map.

CREATE TABLE IF NOT EXISTS td_synnex_ec_express_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  region VARCHAR(8) NOT NULL DEFAULT 'US',
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status VARCHAR(30),
  last_test_at TIMESTAMP,
  last_test_error TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_ec_express_partner_uq
  ON td_synnex_ec_express_integrations (partner_id);

ALTER TABLE td_synnex_ec_express_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_ec_express_integrations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_ec_express_partner_access
    ON td_synnex_ec_express_integrations
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
