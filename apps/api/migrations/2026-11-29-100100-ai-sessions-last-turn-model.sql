-- AI model registry W05 (#7603): the provenance of a chat session's last
-- turn (served model + applied options, an AiTurnModel), written when the
-- turn's `turn_model` event is published, read back on reload. Persisted
-- because the ledger cannot answer it deterministically (one settlement =
-- one row per model key, same timestamp).
-- Tenancy: ai_sessions is shape 1 and already registered everywhere; the
-- column is classified excludedOpen in CORE_TENANT_EXPORT_POLICY (jsonb).
-- DDL only: no row writes.

ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS last_turn_model jsonb;

ALTER TABLE public.ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_last_turn_model_obj_chk;
ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_last_turn_model_obj_chk
  CHECK (last_turn_model IS NULL OR jsonb_typeof(last_turn_model) = 'object');
