-- READ-ONLY preflight for the AI model registry legacy removal (#7606):
--   gate G1 — before W08a (code removal) merges, run against release R0;
--   gate G2 — before W08b (2026-11-28-100000-ai-model-registry-legacy-drop.sql)
--             merges, run against release R1.
-- Run on EACH prod region. Send the output to Todd; never paste it into a PR
-- (it names partner ids).
--
-- PASS = query `blocking_uncut_with_legacy` returns ZERO rows on both regions.
-- A row there is a partner whose legacy AI model settings were never projected
-- into the registry; after W08a nothing projects them any more. Stop and
-- escalate: the fix is to let R0's cutover run for that partner (its first AI
-- request, or an R0 restart), not to edit rows by hand.
--
-- Everything else is informational, and is exactly what W08b archives into
-- ai_model_registry_legacy_archive before it drops the legacy storage.
--
-- This file lives under migrations/preflight/ and is NEVER applied by the
-- runner: autoMigrate reads the migrations root non-recursively and keeps only
-- /^\d{4}-.*\.sql$/, so this directory is skipped (same as optional/).
--
-- ============================ READ THIS FIRST ============================
-- THE SCOPE ELEVATION BELOW IS LOAD-BEARING. Every table read here is FORCE
-- ROW LEVEL SECURITY, which binds the table owner too; breeze_current_scope()
-- defaults to 'none', under which every tenant policy is false. Unelevated,
-- every query returns ZERO ROWS WHILE BLIND, which reads as "clean". Query
-- `sanity` makes blindness visible: if `partners` is 0 on a region that has
-- partners, fix the connection and do NOT report "clean".
--
-- BEGIN READ ONLY / ROLLBACK keeps the elevation transaction-local and makes
-- any write impossible. The migration "no BEGIN/COMMIT" rule does not apply:
-- autoMigrate never runs this file.
-- =========================================================================

BEGIN READ ONLY;

SELECT set_config('breeze.scope', 'system', true);

-- @query sanity
SELECT public.breeze_current_scope() AS effective_scope,
       (SELECT count(*) FROM public.partners) AS partners,
       (SELECT count(*) FROM public.partner_ai_connections) AS connections,
       (SELECT count(*) FROM public.ai_model_registry_partner_cutover) AS cutover_rows;

-- @query sweep_state
SELECT cutover_completed_at, lease_owner IS NOT NULL AS lease_held, lease_expires_at
  FROM public.ai_model_registry_state;

-- @query blocking_uncut_with_legacy
WITH legacy AS (
  SELECT c.partner_id, 'partner_llm_configs' AS source
    FROM public.partner_llm_configs c
  UNION ALL
  SELECT k.partner_id, 'partner_ai_connections'
    FROM public.partner_ai_connections k WHERE k.kind IN ('anthropic_byok', 'catalog')
  UNION ALL
  SELECT COALESCE(sp.partner_id, o.partner_id), 'ai_script_policies.reviewer_model'
    FROM public.ai_script_policies sp LEFT JOIN public.organizations o ON o.id = sp.org_id
   WHERE sp.reviewer_model IS NOT NULL
  UNION ALL
  SELECT o.partner_id, 'client_ai_org_policies.allowed_models'
    FROM public.client_ai_org_policies p JOIN public.organizations o ON o.id = p.org_id
   WHERE p.allowed_models IS NOT NULL AND p.allowed_models <> '[]'::jsonb
  UNION ALL
  -- The column default ('["claude-sonnet-4-5-20250929"]', 0001-baseline.sql)
  -- is not a customization: the W02 projection ignored it too.
  SELECT o.partner_id, 'ai_budgets.allowed_models'
    FROM public.ai_budgets b JOIN public.organizations o ON o.id = b.org_id
   WHERE b.allowed_models IS NOT NULL AND b.allowed_models <> '["claude-sonnet-4-5-20250929"]'::jsonb
  UNION ALL
  SELECT COALESCE(a.partner_id, o.partner_id), 'ai_agents.model'
    FROM public.ai_agents a LEFT JOIN public.organizations o ON o.id = a.org_id
   WHERE a.model IS NOT NULL
  UNION ALL
  SELECT o.partner_id, 'ai_sessions (active, unbound)'
    FROM public.ai_sessions s JOIN public.organizations o ON o.id = s.org_id
   WHERE s.status = 'active' AND s.offering_id IS NULL
)
SELECT l.partner_id, array_agg(DISTINCT l.source ORDER BY l.source) AS legacy_sources
  FROM legacy l
 WHERE l.partner_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover c WHERE c.partner_id = l.partner_id)
 GROUP BY l.partner_id
 ORDER BY l.partner_id;

-- @query counts
SELECT 'partner_llm_configs rows' AS item, count(*) AS n FROM public.partner_llm_configs
UNION ALL SELECT 'partner_llm_configs rows with no same-id connection', count(*)
  FROM public.partner_llm_configs c WHERE NOT EXISTS (SELECT 1 FROM public.partner_ai_connections k WHERE k.id = c.id)
UNION ALL SELECT 'partner_llm_configs.default_model set', count(*) FROM public.partner_llm_configs WHERE default_model IS NOT NULL
UNION ALL SELECT 'partner_ai_connections.legacy_default_model set', count(*) FROM public.partner_ai_connections WHERE legacy_default_model IS NOT NULL
UNION ALL SELECT 'partners with more than one anthropic_byok/catalog connection', count(*) FROM (
  SELECT partner_id FROM public.partner_ai_connections WHERE kind IN ('anthropic_byok', 'catalog')
   GROUP BY partner_id HAVING count(*) > 1) x
UNION ALL SELECT 'ai_budgets rows', count(*) FROM public.ai_budgets
UNION ALL SELECT 'ai_budgets.allowed_models customized', count(*) FROM public.ai_budgets
  WHERE allowed_models IS NOT NULL AND allowed_models <> '["claude-sonnet-4-5-20250929"]'::jsonb
UNION ALL SELECT 'ai_script_policies.reviewer_model set', count(*) FROM public.ai_script_policies WHERE reviewer_model IS NOT NULL
UNION ALL SELECT 'client_ai_org_policies.allowed_models non-empty', count(*) FROM public.client_ai_org_policies
  WHERE allowed_models IS NOT NULL AND allowed_models <> '[]'::jsonb
UNION ALL SELECT 'ai_agents.model set', count(*) FROM public.ai_agents WHERE model IS NOT NULL
UNION ALL SELECT 'ai_agents.model set, live and unbound', count(*) FROM public.ai_agents
  WHERE model IS NOT NULL AND offering_id IS NULL AND disabled_at IS NULL
UNION ALL SELECT 'ai_invocations shadow rows', count(*) FROM public.ai_invocations WHERE ledger_mode = 'shadow'
UNION ALL SELECT 'partners without a cutover row', count(*) FROM public.partners p
  WHERE NOT EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover c WHERE c.partner_id = p.id);

-- @query unrepresented_models
WITH offered AS (
  SELECT m.partner_id, COALESCE(m.model_id, pm.model_id) AS model_id
    FROM public.partner_ai_models m LEFT JOIN public.ai_platform_models pm ON pm.id = m.platform_model_id
), legacy_models AS (
  SELECT c.partner_id, 'partner_llm_configs.default_model' AS source, c.default_model AS model_id
    FROM public.partner_llm_configs c WHERE c.default_model IS NOT NULL
  UNION ALL
  SELECT k.partner_id, 'partner_ai_connections.legacy_default_model', k.legacy_default_model
    FROM public.partner_ai_connections k WHERE k.legacy_default_model IS NOT NULL
  UNION ALL
  SELECT COALESCE(sp.partner_id, o.partner_id), 'ai_script_policies.reviewer_model', sp.reviewer_model
    FROM public.ai_script_policies sp LEFT JOIN public.organizations o ON o.id = sp.org_id
   WHERE sp.reviewer_model IS NOT NULL
  UNION ALL
  SELECT o.partner_id, 'client_ai_org_policies.allowed_models', jsonb_array_elements_text(p.allowed_models)
    FROM public.client_ai_org_policies p JOIN public.organizations o ON o.id = p.org_id
   WHERE jsonb_typeof(p.allowed_models) = 'array'
  UNION ALL
  SELECT o.partner_id, 'ai_budgets.allowed_models', jsonb_array_elements_text(b.allowed_models)
    FROM public.ai_budgets b JOIN public.organizations o ON o.id = b.org_id
   WHERE jsonb_typeof(b.allowed_models) = 'array'
     AND b.allowed_models <> '["claude-sonnet-4-5-20250929"]'::jsonb
  UNION ALL
  SELECT COALESCE(a.partner_id, o.partner_id), 'ai_agents.model', a.model
    FROM public.ai_agents a LEFT JOIN public.organizations o ON o.id = a.org_id
   WHERE a.model IS NOT NULL
)
SELECT l.source, l.model_id, count(*) AS references, count(DISTINCT l.partner_id) AS partners
  FROM legacy_models l
 WHERE NOT EXISTS (SELECT 1 FROM offered f WHERE f.partner_id = l.partner_id AND f.model_id = l.model_id)
 GROUP BY l.source, l.model_id
 ORDER BY l.source, count(*) DESC;

ROLLBACK;
