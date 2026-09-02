CREATE TABLE IF NOT EXISTS partner_llm_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'anthropic',
  api_key_encrypted text NOT NULL,
  key_last4 text NOT NULL,
  key_fingerprint text NOT NULL,
  base_url text,
  default_model text,
  status text NOT NULL DEFAULT 'active',
  config_version integer NOT NULL DEFAULT 1,
  last_error text,
  verified_at timestamptz,
  connected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_llm_configs_provider_chk CHECK (provider = 'anthropic'),
  CONSTRAINT partner_llm_configs_base_url_chk CHECK (base_url IS NULL),
  CONSTRAINT partner_llm_configs_status_chk CHECK (status IN ('active', 'error'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_llm_configs_provider_chk'
      AND conrelid = 'partner_llm_configs'::regclass
  ) THEN
    ALTER TABLE partner_llm_configs
      ADD CONSTRAINT partner_llm_configs_provider_chk CHECK (provider = 'anthropic');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_llm_configs_base_url_chk'
      AND conrelid = 'partner_llm_configs'::regclass
  ) THEN
    ALTER TABLE partner_llm_configs
      ADD CONSTRAINT partner_llm_configs_base_url_chk CHECK (base_url IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_llm_configs_status_chk'
      AND conrelid = 'partner_llm_configs'::regclass
  ) THEN
    ALTER TABLE partner_llm_configs
      ADD CONSTRAINT partner_llm_configs_status_chk CHECK (status IN ('active', 'error'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS partner_llm_configs_partner_uq
  ON partner_llm_configs(partner_id);

ALTER TABLE partner_llm_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_llm_configs FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_llm_configs'
      AND policyname = 'partner_llm_configs_partner_access'
  ) THEN
    CREATE POLICY partner_llm_configs_partner_access ON partner_llm_configs
      FOR ALL TO breeze_app
      USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      )
      WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON partner_llm_configs TO breeze_app;
