-- Phase 2 of per-partner LLM BYOK (#3922): provenance columns on ai_sessions so a
-- session's cost/billing can be traced back to the exact catalog entry + immutable
-- revision it was billed against. Both nullable — sessions billed to the platform
-- key or a partner's direct Anthropic key never set these.

ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS catalog_entry_id uuid REFERENCES llm_provider_catalog(id),
  ADD COLUMN IF NOT EXISTS catalog_revision_id uuid REFERENCES llm_provider_catalog_revisions(id);
