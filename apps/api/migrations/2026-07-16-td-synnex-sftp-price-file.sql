-- TD SYNNEX Nightly SFTP Price & Availability file ingest.
--
-- Two partner-axis (RLS shape 3) tables:
--   td_synnex_sftp_integrations  -- per-partner connector config, encrypted creds
--   td_synnex_price_availability -- the ingested P&A rows, one per (partner, sku)
--
-- No host column: the SFTP host is server-controlled via a region map in
-- services/tdSynnexSftpSync.ts, matching the EC Express connector. A partner
-- cannot point this connector at an arbitrary host.
--
-- The SFTP username and the remote filename are DERIVED from the account number
-- ('u' + accountNumber, and accountNumber + '.zip'), so neither is stored twice.

CREATE TABLE IF NOT EXISTS td_synnex_sftp_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  region VARCHAR(8) NOT NULL DEFAULT 'US',
  -- Account number is an identifier, not a credential: it is visible in the SFTP
  -- username and the remote filename, and both are derived from it. Only the
  -- password is encrypted (credentials.password), which keeps it on the existing
  -- SECRET_JSON_KEYS rotation path without adding a new key to that global set.
  account_number VARCHAR(32),
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status VARCHAR(30),
  last_test_at TIMESTAMP,
  last_test_error TEXT,
  last_sync_at TIMESTAMP,
  last_sync_status VARCHAR(20),
  last_sync_error TEXT,
  last_file_name TEXT,
  last_row_count INTEGER,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_sftp_partner_uq
  ON td_synnex_sftp_integrations (partner_id);

ALTER TABLE td_synnex_sftp_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_sftp_integrations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_sftp_partner_access
    ON td_synnex_sftp_integrations
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ingested price & availability rows. Superset of the EC Express SOAP shape
-- (TdSynnexEcProduct) so the two connectors stay conceptually aligned.
CREATE TABLE IF NOT EXISTS td_synnex_price_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  synnex_sku VARCHAR(64) NOT NULL,
  mfg_part_no VARCHAR(128),
  name TEXT,
  description TEXT,
  status VARCHAR(32),
  currency VARCHAR(8),
  cost NUMERIC(12,4),
  msrp NUMERIC(12,4),
  total_qty INTEGER,
  warehouses JSONB NOT NULL DEFAULT '[]'::jsonb,
  weight NUMERIC(10,3),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_date DATE,
  synced_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_pa_partner_sku_uq
  ON td_synnex_price_availability (partner_id, synnex_sku);
CREATE INDEX IF NOT EXISTS td_synnex_pa_partner_mfg_idx
  ON td_synnex_price_availability (partner_id, mfg_part_no);
CREATE INDEX IF NOT EXISTS td_synnex_pa_partner_synced_idx
  ON td_synnex_price_availability (partner_id, synced_at);

ALTER TABLE td_synnex_price_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_price_availability FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_price_availability_partner_access
    ON td_synnex_price_availability
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
