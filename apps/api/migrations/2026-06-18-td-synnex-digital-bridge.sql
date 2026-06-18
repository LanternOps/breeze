-- TD SYNNEX Digital Bridge catalog integration.
-- Partner-axis (shape 3) with encrypted credential JSON.

CREATE TABLE IF NOT EXISTS td_synnex_digital_bridge_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
  region VARCHAR(50) NOT NULL DEFAULT 'US',
  base_url TEXT NOT NULL,
  auth_type VARCHAR(20) NOT NULL DEFAULT 'api_key',
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status VARCHAR(30),
  last_test_at TIMESTAMP,
  last_test_error TEXT,
  last_sync_at TIMESTAMP,
  last_error TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_digital_bridge_partner_uq
  ON td_synnex_digital_bridge_integrations (partner_id);

CREATE INDEX IF NOT EXISTS td_synnex_digital_bridge_partner_enabled_idx
  ON td_synnex_digital_bridge_integrations (partner_id, enabled);

ALTER TABLE td_synnex_digital_bridge_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_digital_bridge_integrations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_digital_bridge_partner_access
    ON td_synnex_digital_bridge_integrations
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
