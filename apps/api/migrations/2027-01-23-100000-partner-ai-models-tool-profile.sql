-- Tool profiles and context window facts on partner_ai_models (#11394,
-- feature #11393, spec 2026-11-06-small-model-tool-profiles).
--
--   tool_profile        auto | full | standard | minimal | custom
--                       (mirrors AI_TOOL_PROFILES in @breeze/shared). `auto`
--                       with an unknown window resolves to `full`, so the
--                       default changes nothing for any existing offering.
--   tool_allowlist      jsonb { domains, tools }, present exactly when the
--                       profile is `custom`.
--   context_window_*    partner override (1024..100 000 000), the window the
--                       connection's model list reports (discovered), and the
--                       window an upstream rejection revealed (observed, with
--                       the time and connection config_version it was seen at).
--
-- Every column is nullable or defaulted, so existing rows are valid as they
-- stand; nothing reads the new columns until a later wave turns profiles on.
--
-- Tenancy: partner_ai_models is shape 3 (partner axis) with its existing
-- policies (partner_ai_models_partner_access FOR ALL +
-- partner_ai_models_org_read_enabled FOR SELECT). New columns inherit them.
-- The table is not in CORE_ORG_CASCADE_DELETE_ORDER nor
-- CORE_TENANT_EXPORT_POLICY, so the columns need no export classification.
--
-- Writes no rows, so no breeze.scope election. Idempotent: ADD COLUMN IF NOT
-- EXISTS and pg_constraint-guarded CHECKs.

ALTER TABLE public.partner_ai_models
  ADD COLUMN IF NOT EXISTS tool_profile text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS tool_allowlist jsonb,
  ADD COLUMN IF NOT EXISTS context_window_override integer,
  ADD COLUMN IF NOT EXISTS context_window_discovered integer,
  ADD COLUMN IF NOT EXISTS context_window_observed integer,
  ADD COLUMN IF NOT EXISTS context_window_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS context_window_observed_config_version integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_ai_models_tool_profile_chk' AND conrelid = 'public.partner_ai_models'::regclass) THEN
    ALTER TABLE public.partner_ai_models
      ADD CONSTRAINT partner_ai_models_tool_profile_chk
      CHECK (tool_profile IN ('auto', 'full', 'standard', 'minimal', 'custom'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_ai_models_tool_allowlist_chk' AND conrelid = 'public.partner_ai_models'::regclass) THEN
    ALTER TABLE public.partner_ai_models
      ADD CONSTRAINT partner_ai_models_tool_allowlist_chk
      CHECK ((tool_profile = 'custom') = (tool_allowlist IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_ai_models_context_window_override_chk' AND conrelid = 'public.partner_ai_models'::regclass) THEN
    ALTER TABLE public.partner_ai_models
      ADD CONSTRAINT partner_ai_models_context_window_override_chk
      CHECK (context_window_override IS NULL OR context_window_override BETWEEN 1024 AND 100000000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_ai_models_context_window_observed_chk' AND conrelid = 'public.partner_ai_models'::regclass) THEN
    ALTER TABLE public.partner_ai_models
      ADD CONSTRAINT partner_ai_models_context_window_observed_chk
      CHECK (num_nulls(context_window_observed, context_window_observed_at, context_window_observed_config_version) IN (0, 3));
  END IF;
END $$;
