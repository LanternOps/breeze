CREATE TABLE IF NOT EXISTS accounting_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  provider varchar(20) NOT NULL,
  realm_id_encrypted text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  environment varchar(12) NOT NULL DEFAULT 'production',
  home_currency char(3),
  default_income_account_ref varchar(64),
  default_tax_code_ref varchar(64),
  push_mode varchar(10) NOT NULL DEFAULT 'auto',
  webhook_verifier_token_encrypted text,
  cdc_cursor timestamptz,
  status varchar(20) NOT NULL DEFAULT 'connected',
  last_sync_at timestamptz,
  last_error text,
  connected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_partner_provider_idx
  ON accounting_connections(partner_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_id_partner_idx
  ON accounting_connections(id, partner_id);

ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON accounting_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON accounting_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON accounting_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON accounting_connections;
CREATE POLICY breeze_partner_isolation_select ON accounting_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON accounting_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON accounting_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON accounting_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
