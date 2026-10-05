-- Replay of 2026-11-12-110000-partner-llm-catalog-pin-default-model.sql (#7618).
--
-- The shipped pin elected system scope, but partner_llm_configs' only policy
-- at that point was `partner_llm_configs_partner_access ... FOR ALL TO
-- breeze_app` (2026-09-04). A policy restricted to breeze_app does not apply to
-- any other role, so under FORCE ROW LEVEL SECURITY a migration role that is
-- neither superuser nor BYPASSRLS saw no rows and the UPDATE pinned 0 of them.
-- Two days later 2026-11-14-100000-ai-model-registry-connections.sql added
-- `partner_llm_configs_system_only` with no TO clause, so the same UPDATE now
-- reaches the rows for any migration role that elects system scope. The
-- shipped file is content-hash immutable, so the effect is re-applied here.
--
-- Same predicate and same value as the original: only catalog-backed rows that
-- still track the platform default (default_model NULL) and whose catalog
-- entry's ACTIVE revision maps claude-sonnet-4-6 are pinned to it.
--
-- 2026-11-14 also copied every partner_llm_configs row into
-- partner_ai_connections by id (legacy_default_model = default_model), and the
-- update mirror trigger it added was dropped on 2026-11-19. The copy therefore
-- still holds the NULL the failed pin left behind, so the same rows' copies are
-- pinned too: only connections with the SAME id, partner and catalog entry as
-- a row pinned by this statement, and only while their legacy_default_model is
-- still NULL. Connections that never came from a legacy row are not touched.
--
-- Where the original took effect (superuser / BYPASSRLS migrator — every
-- hosted region) every row is already pinned and both counts print 0.
--
-- WRITES ROWS: system scope is elected first. Both counts are logged (WARNING
-- when non-zero, NOTICE otherwise). Idempotent: a re-run matches nothing
-- because default_model is no longer NULL. Guarded on the tables existing so a
-- database that has already retired the legacy storage skips it. autoMigrate
-- wraps this file in a transaction: no BEGIN/COMMIT.
DO $$
DECLARE
  n_configs integer := 0;
  n_connections integer := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF to_regclass('public.partner_llm_configs') IS NULL THEN
    RAISE NOTICE 'partner_llm_configs: table absent, catalog default-model pin replay skipped';
    RETURN;
  END IF;

  IF to_regclass('public.partner_ai_connections') IS NOT NULL THEN
    WITH pinned AS (
      UPDATE public.partner_llm_configs AS c
         SET default_model = 'claude-sonnet-4-6',
             config_version = c.config_version + 1,
             updated_at = now()
        FROM public.llm_provider_catalog AS e
        JOIN public.llm_provider_catalog_revisions AS r
          ON r.id = e.active_revision_id
       WHERE c.catalog_entry_id = e.id
         AND c.default_model IS NULL
         AND r.model_map ? 'claude-sonnet-4-6'
      RETURNING c.id, c.partner_id, c.catalog_entry_id
    ), mirrored AS (
      UPDATE public.partner_ai_connections AS k
         SET legacy_default_model = 'claude-sonnet-4-6',
             updated_at = now()
        FROM pinned AS p
       WHERE k.id = p.id
         AND k.partner_id = p.partner_id
         AND k.kind = 'catalog'
         AND k.catalog_entry_id = p.catalog_entry_id
         AND k.legacy_default_model IS NULL
      RETURNING k.id
    )
    SELECT (SELECT count(*) FROM pinned), (SELECT count(*) FROM mirrored)
      INTO n_configs, n_connections;
  ELSE
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
    GET DIAGNOSTICS n_configs = ROW_COUNT;
  END IF;

  IF n_configs > 0 OR n_connections > 0 THEN
    RAISE WARNING 'partner_llm_configs: replayed default_model=claude-sonnet-4-6 pin on % catalog-backed row(s) and % mirrored connection(s)', n_configs, n_connections;
  ELSE
    RAISE NOTICE 'partner_llm_configs: replayed default_model=claude-sonnet-4-6 pin on % catalog-backed row(s) and % mirrored connection(s)', n_configs, n_connections;
  END IF;
END $$;
