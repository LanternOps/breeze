-- Pin the model on catalog-backed partner LLM configs that were tracking the
-- platform default (#7587).
--
-- A partner on a catalog endpoint (partner_llm_configs.catalog_entry_id set)
-- with default_model NULL runs whatever resolveDefaultModel() returns, and
-- the resolver refuses it (unavailable 'model_unverified') unless the pinned
-- revision both maps and has verified that exact id. #7587 moves the platform
-- default from claude-sonnet-4-6 to claude-sonnet-5-5, which no existing
-- revision can map (it was not an offerable model until the same change). Left
-- alone, every org under such a partner would get ai_unavailable on chat,
-- agents and one-shot surfaces as soon as the new default ships.
--
-- These rows were running claude-sonnet-4-6, so pin exactly that. Only rows
-- whose catalog entry's ACTIVE revision maps claude-sonnet-4-6 are touched:
-- a listed revision has verified every model it maps, so the pin keeps the
-- partner on a model their endpoint already serves. A row whose revision does
-- not map it was not being served claude-sonnet-4-6 (e.g. a self-host
-- ANTHROPIC_MODEL override) and is left unchanged. From #7587 on,
-- updatePartnerLlmEndpoint persists the model it validated, so a catalog
-- selection never tracks the moving default again.
--
-- config_version is bumped so cached resolved configs are refreshed, the same
-- as every other partner LLM config write.
--
-- WRITES ROWS: system scope is set first, because FORCE RLS applies to the
-- migration role. The count is logged either way: WARNING when rows changed,
-- NOTICE when none did. Idempotent: a re-run matches nothing (default_model is
-- no longer NULL). autoMigrate wraps this file in a transaction, so there is no
-- BEGIN/COMMIT here.
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.partner_llm_configs AS c
     SET default_model = 'claude-sonnet-4-6',
         config_version = c.config_version + 1,
         updated_at = now()
    FROM public.llm_provider_catalog AS e
    JOIN public.llm_provider_catalog_revisions AS r
      ON r.id = e.active_revision_id
   WHERE c.catalog_entry_id = e.id
     AND c.default_model IS NULL
     AND r.model_map ? 'claude-sonnet-4-6';

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'partner_llm_configs: pinned default_model=claude-sonnet-4-6 on % catalog-backed row(s) that tracked the platform default', n;
  ELSE
    RAISE NOTICE 'partner_llm_configs: pinned default_model=claude-sonnet-4-6 on % catalog-backed row(s) that tracked the platform default', n;
  END IF;
END $$;
