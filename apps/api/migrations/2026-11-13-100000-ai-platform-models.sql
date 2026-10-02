-- AI model registry W01 (#7599, spec §5.1): system-wide platform model catalog.
--
-- One row per Anthropic model the platform knows. Each row holds:
--   * id, display name and token limits from the Models API;
--   * the raw `capabilities` tree, stored verbatim;
--   * operator prices (NULL = unpriced) and option-variant rates;
--   * option support (derived plus operator-set);
--   * the hosted plan gate, the prompt profile, the platform offer flag,
--     the single platform default, and the discovery lifecycle.
--
-- System-wide: no org_id or partner_id, NO RLS. This mirrors
-- llm_provider_catalog (2026-09-12-llm-provider-catalog.sql). Every request
-- context reads it (pricing, capability lookups). Writes are gated at the
-- application layer to the discovery worker and the platform-admin + MFA
-- /admin/ai-models routes. Classified INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts.
--
-- DDL only (no rows written), so no breeze.scope election is needed; the
-- seed lives in 2026-11-13-100100-ai-platform-models-seed.sql. Idempotent;
-- autoMigrate wraps the file in a transaction (no BEGIN/COMMIT here).

CREATE TABLE IF NOT EXISTS ai_platform_models (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 text NOT NULL DEFAULT 'anthropic',
  model_id                 text NOT NULL,
  display_name             text NOT NULL,
  max_input_tokens         integer,
  max_output_tokens        integer,
  capabilities             jsonb,
  input_cents_per_m        numeric(12,4),
  output_cents_per_m       numeric(12,4),
  cache_read_cents_per_m   numeric(12,4),
  cache_write_cents_per_m  numeric(12,4),
  option_rates             jsonb,
  option_support           jsonb NOT NULL DEFAULT '{"effort":[],"thinkingDisplay":[],"speed":["standard"],"inferenceGeo":[]}'::jsonb,
  min_plan                 text,
  prompt_profile           text NOT NULL DEFAULT 'generic',
  platform_offered         boolean NOT NULL DEFAULT false,
  is_platform_default      boolean NOT NULL DEFAULT false,
  lifecycle                text NOT NULL DEFAULT 'available',
  missed_sync_count        integer NOT NULL DEFAULT 0,
  operator_notified_at     timestamptz,
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_platform_models_model_id_uq UNIQUE (model_id),
  CONSTRAINT ai_platform_models_provider_chk CHECK (provider IN ('anthropic')),
  CONSTRAINT ai_platform_models_lifecycle_chk CHECK (lifecycle IN ('available', 'missing', 'retired')),
  CONSTRAINT ai_platform_models_prompt_profile_chk CHECK (prompt_profile IN ('claude-frontier', 'claude-standard', 'claude-small', 'generic')),
  CONSTRAINT ai_platform_models_prices_nonneg_chk CHECK (
    (input_cents_per_m IS NULL OR input_cents_per_m >= 0)
    AND (output_cents_per_m IS NULL OR output_cents_per_m >= 0)
    AND (cache_read_cents_per_m IS NULL OR cache_read_cents_per_m >= 0)
    AND (cache_write_cents_per_m IS NULL OR cache_write_cents_per_m >= 0)
  ),
  CONSTRAINT ai_platform_models_offered_priced_chk CHECK (
    NOT platform_offered OR (
      input_cents_per_m IS NOT NULL
      AND output_cents_per_m IS NOT NULL
      AND cache_read_cents_per_m IS NOT NULL
      AND cache_write_cents_per_m IS NOT NULL
    )
  ),
  CONSTRAINT ai_platform_models_default_offered_chk CHECK (NOT is_platform_default OR platform_offered),
  CONSTRAINT ai_platform_models_missed_nonneg_chk CHECK (missed_sync_count >= 0),
  CONSTRAINT ai_platform_models_option_support_obj_chk CHECK (jsonb_typeof(option_support) = 'object'),
  CONSTRAINT ai_platform_models_option_rates_obj_chk CHECK (option_rates IS NULL OR jsonb_typeof(option_rates) = 'object')
);

-- At most one platform default (spec §5.1).
CREATE UNIQUE INDEX IF NOT EXISTS ai_platform_models_one_default_uq
  ON ai_platform_models (is_platform_default)
  WHERE is_platform_default;
