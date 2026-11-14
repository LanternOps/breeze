-- Preserve every existing link. Only software policies become additive.
DROP INDEX IF EXISTS public.config_feature_links_unique;
CREATE UNIQUE INDEX IF NOT EXISTS config_feature_links_unique
  ON public.config_policy_feature_links (config_policy_id, feature_type)
  WHERE feature_type <> 'software_policy';
CREATE UNIQUE INDEX IF NOT EXISTS config_feature_links_software_unique
  ON public.config_policy_feature_links
    (config_policy_id, (coalesce(feature_policy_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE feature_type = 'software_policy';

-- Keep security_invoker and the existing columns/permissions: the caller's RLS
-- continues to control visibility. Parent software links also accumulate.
CREATE OR REPLACE VIEW public.config_policy_effective_feature_links
  WITH (security_invoker = true) AS
  SELECT l.id, l.config_policy_id, l.config_policy_id AS source_policy_id,
         l.feature_type, l.feature_policy_id, l.inline_settings, l.created_at, l.updated_at,
         false AS inherited
    FROM public.config_policy_feature_links l
  UNION ALL
  SELECT pl.id, c.id AS config_policy_id, pl.config_policy_id AS source_policy_id,
         pl.feature_type, pl.feature_policy_id, pl.inline_settings, pl.created_at, pl.updated_at,
         true AS inherited
    FROM public.configuration_policies c
    JOIN public.config_policy_feature_links pl ON pl.config_policy_id = c.parent_policy_id
   WHERE c.parent_policy_id IS NOT NULL
     AND (pl.feature_type = 'software_policy' OR NOT EXISTS (
       SELECT 1 FROM public.config_policy_feature_links own
        WHERE own.config_policy_id = c.id AND own.feature_type = pl.feature_type
     ));
