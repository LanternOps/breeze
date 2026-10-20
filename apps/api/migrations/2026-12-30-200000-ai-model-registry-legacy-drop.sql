-- AI model registry W08b (#7606): archive, then drop, the legacy AI model
-- configuration. One release after W08a deleted every reader (#6472: code
-- first, drop later — an N-1 rollback window).
--
-- Drops: partner_llm_configs (table), ai_model_registry_state (W03 sweep
-- singleton), partner_ai_connections.legacy_default_model,
-- partner_ai_connections_compat_uq, ai_budgets.allowed_models,
-- ai_script_policies.reviewer_model, client_ai_org_policies.allowed_models,
-- ai_agents.model.
--
-- ARCHIVE BEFORE DROP, NEVER REFUSE. Every legacy value that still exists is
-- copied into ai_model_registry_legacy_archive first (a full snapshot, not only
-- values the registry lacks; the only skipped value is client_ai_org_policies'
-- empty '[]' default, which configures nothing), keyed (source_table,
-- source_id, source_column),
-- so a re-apply is a no-op. Per #6472 nothing here raises on tenant data:
-- partners that held legacy config without a registry row are COUNTED in a
-- warning (their values are in the archive), and a column already dropped by
-- hand is skipped, not refused. The only RAISE EXCEPTION is the final proof,
-- which can fire only if a DROP silently failed.
--
-- partner_llm_configs.api_key_encrypted and key_fingerprint are NOT archived
-- (W08 D8): live keys are in partner_ai_connections (same id, same AAD tag);
-- what remains in the legacy table is a frozen copy, including keys partners
-- have since disconnected, and destroying it is the point.
--
-- The archive is partner-axis (shape 3) like legacy_labour_pricing_archive:
-- org_id is metadata on org-level rows, for the cascade / merge / export
-- contracts. Registered in CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry
-- (repoint), CORE_TENANT_EXPORT_POLICY (value → excludedOpen) and, in
-- rls-coverage, ORG_AXIS_POLICY_EXCLUDED_TABLES + PARTNER_TENANT_TABLES.
--
-- WRITES ROWS (the archive): system scope is elected first, at file level and
-- inside each DO block. FORCE RLS binds the migration role too; without it the
-- archive inserts match zero rows and the counts read 0 (fail-open). Every
-- source table's policies are role-agnostic (no TO clause), so a migration
-- owner that is neither breeze_app nor BYPASSRLS sees them under system scope.
--
-- No named constraint on an EXISTING table is touched with ALTER ...
-- CONSTRAINT: replayMigration re-runs later migrations that touch a constraint
-- name a replayed file touches. The only ADD CONSTRAINT is on the table this
-- file creates. DROP COLUMN / DROP INDEX / DROP TABLE are not in that closure.
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

-- 1) Report partners whose legacy config was never projected (never refuse).
DO $$
DECLARE uncut integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF to_regclass('public.partner_llm_configs') IS NULL THEN
    RAISE WARNING 'AI model registry W08b: partner_llm_configs already dropped; no un-cut partners to report';
    RETURN;
  END IF;
  EXECUTE $q$
    SELECT count(DISTINCT c.partner_id)::int
      FROM public.partner_llm_configs c
     WHERE NOT EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover k WHERE k.partner_id = c.partner_id) $q$
    INTO uncut;
  RAISE WARNING 'AI model registry W08b: % partner(s) held legacy AI model config without a registry row (values archived below)', uncut;
END $$;

-- 2) The archive table (partner axis, RLS in the same migration).
CREATE TABLE IF NOT EXISTS public.ai_model_registry_legacy_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id),
  org_id uuid,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  source_column text NOT NULL,
  value jsonb NOT NULL,
  had_cutover boolean NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_registry_legacy_archive_source_table_chk CHECK (source_table IN (
    'partner_llm_configs', 'partner_ai_connections', 'ai_budgets', 'ai_script_policies', 'client_ai_org_policies', 'ai_agents')),
  CONSTRAINT ai_model_registry_legacy_archive_source_uniq UNIQUE (source_table, source_id, source_column)
);

-- ON DELETE CASCADE as well as the cascade-list registration: the previous
-- release's code does not know this table, so after a rollback an org erasure
-- on that image must not abort on it (W08 D12). Deferrable for the org-merge
-- contract (SET CONSTRAINTS ALL DEFERRED).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_model_registry_legacy_archive_org_partner_fk') THEN
    ALTER TABLE public.ai_model_registry_legacy_archive ADD CONSTRAINT ai_model_registry_legacy_archive_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations (id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_model_registry_legacy_archive_partner_idx ON public.ai_model_registry_legacy_archive (partner_id);
CREATE INDEX IF NOT EXISTS ai_model_registry_legacy_archive_org_idx ON public.ai_model_registry_legacy_archive (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE public.ai_model_registry_legacy_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_registry_legacy_archive FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'ai_model_registry_legacy_archive' AND policyname = 'ai_model_registry_legacy_archive_partner_access'
  ) THEN
    -- No TO clause (as partner_ai_connections, 2026-11-14-100000): a role-scoped
    -- policy leaves a non-BYPASSRLS migration owner with NO applicable policy
    -- under FORCE RLS, so even with system scope elected the archive insert
    -- below would be refused. Table GRANTs restrict who reaches the table.
    CREATE POLICY ai_model_registry_legacy_archive_partner_access ON public.ai_model_registry_legacy_archive
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model_registry_legacy_archive TO breeze_app;

-- 3) Archive every legacy value that still exists. Each source is guarded on
--    its own table/column, so a partial set is archived column by column.
--    Dynamic SQL (EXECUTE) because a branch's static SQL would fail to plan
--    when its column is already gone.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF to_regclass('public.partner_llm_configs') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT c.partner_id, NULL, 'partner_llm_configs', c.id, 'row',
             jsonb_build_object(
               'provider', c.provider, 'key_last4', c.key_last4, 'base_url', c.base_url, 'default_model', c.default_model,
               'catalog_entry_id', c.catalog_entry_id, 'status', c.status, 'config_version', c.config_version,
               'last_error', c.last_error, 'verified_at', c.verified_at, 'connected_by', c.connected_by,
               'created_at', c.created_at, 'updated_at', c.updated_at,
               'in_registry', EXISTS (SELECT 1 FROM public.partner_ai_connections k WHERE k.id = c.id)),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = c.partner_id)
        FROM public.partner_llm_configs c
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % partner_llm_configs row(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: partner_llm_configs already dropped; archived 0';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'partner_ai_connections' AND column_name = 'legacy_default_model') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT k.partner_id, NULL, 'partner_ai_connections', k.id, 'legacy_default_model', to_jsonb(k.legacy_default_model),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = k.partner_id)
        FROM public.partner_ai_connections k WHERE k.legacy_default_model IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % partner_ai_connections.legacy_default_model value(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: partner_ai_connections.legacy_default_model already dropped; archived 0';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'ai_budgets' AND column_name = 'allowed_models') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT o.partner_id, b.org_id, 'ai_budgets', b.id, 'allowed_models', b.allowed_models,
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = o.partner_id)
        FROM public.ai_budgets b JOIN public.organizations o ON o.id = b.org_id
       WHERE b.allowed_models IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % ai_budgets.allowed_models value(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: ai_budgets.allowed_models already dropped; archived 0';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'ai_script_policies' AND column_name = 'reviewer_model') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT COALESCE(sp.partner_id, o.partner_id), sp.org_id, 'ai_script_policies', sp.id, 'reviewer_model', to_jsonb(sp.reviewer_model),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = COALESCE(sp.partner_id, o.partner_id))
        FROM public.ai_script_policies sp LEFT JOIN public.organizations o ON o.id = sp.org_id
       WHERE sp.reviewer_model IS NOT NULL AND COALESCE(sp.partner_id, o.partner_id) IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % ai_script_policies.reviewer_model value(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: ai_script_policies.reviewer_model already dropped; archived 0';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'client_ai_org_policies' AND column_name = 'allowed_models') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT o.partner_id, p.org_id, 'client_ai_org_policies', p.id, 'allowed_models', p.allowed_models,
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = o.partner_id)
        FROM public.client_ai_org_policies p JOIN public.organizations o ON o.id = p.org_id
       WHERE p.allowed_models IS NOT NULL AND p.allowed_models <> '[]'::jsonb
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % client_ai_org_policies.allowed_models value(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: client_ai_org_policies.allowed_models already dropped; archived 0';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'ai_agents' AND column_name = 'model') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT COALESCE(a.partner_id, o.partner_id), a.org_id, 'ai_agents', a.id, 'model',
             jsonb_build_object('model', a.model, 'offering_id', a.offering_id, 'disabled_at', a.disabled_at),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = COALESCE(a.partner_id, o.partner_id))
        FROM public.ai_agents a LEFT JOIN public.organizations o ON o.id = a.org_id
       WHERE a.model IS NOT NULL AND COALESCE(a.partner_id, o.partner_id) IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % ai_agents.model value(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: ai_agents.model already dropped; archived 0';
  END IF;
END $$;

-- 4) Record the W03 sweep's completion stamp, then drop everything.
DO $$
DECLARE stamp timestamptz;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF to_regclass('public.ai_model_registry_state') IS NOT NULL THEN
    EXECUTE 'SELECT cutover_completed_at FROM public.ai_model_registry_state WHERE id = 1' INTO stamp;
    RAISE WARNING 'AI model registry W08b: dropping ai_model_registry_state (cutover_completed_at = %)', stamp;
  END IF;
END $$;

DROP INDEX IF EXISTS public.partner_ai_connections_compat_uq;
ALTER TABLE public.partner_ai_connections DROP COLUMN IF EXISTS legacy_default_model;
ALTER TABLE public.ai_budgets DROP COLUMN IF EXISTS allowed_models;
ALTER TABLE public.ai_script_policies DROP COLUMN IF EXISTS reviewer_model;
ALTER TABLE public.client_ai_org_policies DROP COLUMN IF EXISTS allowed_models;
ALTER TABLE public.ai_agents DROP COLUMN IF EXISTS model;
DROP TABLE IF EXISTS public.partner_llm_configs;
DROP TABLE IF EXISTS public.ai_model_registry_state;

-- 5) Prove it.
DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining FROM information_schema.columns WHERE table_schema = 'public' AND (
    (table_name = 'partner_ai_connections' AND column_name = 'legacy_default_model') OR
    (table_name = 'ai_budgets' AND column_name = 'allowed_models') OR
    (table_name = 'ai_script_policies' AND column_name = 'reviewer_model') OR
    (table_name = 'client_ai_org_policies' AND column_name = 'allowed_models') OR
    (table_name = 'ai_agents' AND column_name = 'model'));
  IF remaining <> 0
     OR to_regclass('public.partner_llm_configs') IS NOT NULL
     OR to_regclass('public.ai_model_registry_state') IS NOT NULL
     OR to_regclass('public.partner_ai_connections_compat_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'AI model registry W08b: a legacy object survived the drop (% column(s))', remaining;
  END IF;
  RAISE WARNING 'AI model registry W08b: legacy AI model config dropped';
END $$;
