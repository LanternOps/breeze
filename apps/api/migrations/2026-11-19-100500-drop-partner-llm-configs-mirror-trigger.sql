-- AI model registry W03 (#7601), W02 handoff item 2: the /ai/provider facade
-- now writes the registry directly and nothing writes partner_llm_configs, so
-- the legacy -> connection mirror created by
-- 2026-11-14-100000-ai-model-registry-connections.sql is removed. The table
-- itself stays (frozen; read only by the one-time per-partner registry
-- cutover) and is dropped in W08. DDL only, no row writes. Idempotent.
DROP TRIGGER IF EXISTS partner_llm_configs_mirror_to_connection ON public.partner_llm_configs;
DROP FUNCTION IF EXISTS public.partner_llm_configs_mirror_to_connection();
