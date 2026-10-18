/**
 * The legacy AI model configuration objects, as they stood before
 * 2026-12-30-200000-ai-model-registry-legacy-drop.sql archived and dropped
 * them (AI model registry W08b, #7606).
 *
 * A fresh `autoMigrate` creates these objects and drops them later in the same
 * run, so the fully-migrated test database no longer has them. Suites that
 * replay a migration which reads or writes them restore them first, INSIDE A
 * TRANSACTION THAT IS ROLLED BACK (integration files run one at a time, and a
 * later file's rls-coverage / tenant-export contract fails on objects the
 * registries no longer classify).
 *
 * Shapes follow the shipped migrations that created them, constraints
 * included, so a replayed migration meets what a production database has:
 *   2026-09-04-partner-llm-configs.sql + 2026-09-14-partner-llm-catalog-selection.sql
 *     (partner_llm_configs; one row per partner),
 *   2026-11-14-100000-ai-model-registry-connections.sql (its role-agnostic
 *     system-only policy; partner_ai_connections.legacy_default_model),
 *   2026-11-19-100900-ai-connections-soft-disconnect.sql (compat_uq predicate),
 *   0001-baseline.sql (ai_budgets.allowed_models and its default),
 *   2026-10-16-120200-ai-script-policies.sql (reviewer_model text),
 *   2026-06-12-b-client-ai-foundation.sql (client_ai_org_policies.allowed_models),
 *   2026-09-02-ai-agents.sql (ai_agents.model varchar(100)),
 *   2026-11-19-100400-ai-model-registry-cutover.sql (ai_model_registry_state).
 */
export const RESTORE_AI_MODEL_LEGACY_CONFIG_SQL = `
CREATE TABLE IF NOT EXISTS public.partner_llm_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
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
  connected_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  catalog_entry_id uuid REFERENCES public.llm_provider_catalog(id),
  CONSTRAINT partner_llm_configs_provider_chk CHECK (provider = 'anthropic'),
  CONSTRAINT partner_llm_configs_base_url_chk CHECK (base_url IS NULL),
  CONSTRAINT partner_llm_configs_status_chk CHECK (status IN ('active', 'error'))
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_llm_configs_partner_uq ON public.partner_llm_configs (partner_id);
ALTER TABLE public.partner_llm_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_llm_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_llm_configs_system_only ON public.partner_llm_configs;
CREATE POLICY partner_llm_configs_system_only ON public.partner_llm_configs
  FOR ALL USING (public.breeze_current_scope() = 'system') WITH CHECK (public.breeze_current_scope() = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_llm_configs TO breeze_app;

ALTER TABLE public.partner_ai_connections ADD COLUMN IF NOT EXISTS legacy_default_model text;
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_connections_compat_uq
  ON public.partner_ai_connections (partner_id)
  WHERE kind IN ('anthropic_byok', 'catalog') AND status <> 'disconnected';

ALTER TABLE public.ai_budgets ADD COLUMN IF NOT EXISTS allowed_models jsonb DEFAULT '["claude-sonnet-4-5-20250929"]'::jsonb;
ALTER TABLE public.ai_script_policies ADD COLUMN IF NOT EXISTS reviewer_model text;
ALTER TABLE public.client_ai_org_policies ADD COLUMN IF NOT EXISTS allowed_models jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS model varchar(100);

CREATE TABLE IF NOT EXISTS public.ai_model_registry_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutover_completed_at timestamptz NULL,
  lease_owner text NULL,
  lease_expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_model_registry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_registry_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_model_registry_state_system_only ON public.ai_model_registry_state;
CREATE POLICY ai_model_registry_state_system_only ON public.ai_model_registry_state
  FOR ALL USING (public.breeze_current_scope() = 'system') WITH CHECK (public.breeze_current_scope() = 'system');
GRANT SELECT, UPDATE ON public.ai_model_registry_state TO breeze_app;
INSERT INTO public.ai_model_registry_state (id, cutover_completed_at) VALUES (1, now()) ON CONFLICT (id) DO NOTHING;
`;
