-- Phase 2 of per-partner LLM BYOK (#3922), Task 3.1: lets a partner's LLM
-- config select a catalog entry instead of (or alongside) a direct Anthropic
-- key. Deliberately NO ON DELETE action on the FK: deleting a catalog entry
-- that partners are still pinned to must FAIL loud, not silently orphan or
-- null out their routing. Delisting (llm_provider_catalog.status='delisted')
-- is the supported way to retire an entry; the resolver treats a delisted
-- entry as unavailable('provider_delisted') without touching this column.
--
-- base_url stays NULL-checked (partner_llm_configs_base_url_chk) and
-- provider stays pinned to 'anthropic' (partner_llm_configs_provider_chk) —
-- both are dialect markers shared by direct and catalog rows; catalog-mode
-- rows carry their real base URL on the catalog revision, not here.

ALTER TABLE partner_llm_configs
  ADD COLUMN IF NOT EXISTS catalog_entry_id uuid REFERENCES llm_provider_catalog(id);
