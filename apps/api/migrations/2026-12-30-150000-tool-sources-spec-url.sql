-- Tool Catalog W02 (#5215 / #5217) — OpenAPI source kind.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.2 (W2 amendment).
-- Plan: docs/superpowers/plans/ai-mcp/2026-09-21-tool-catalog-w2-openapi-source-kind.md (D3, D17).
--
-- `tool_source_kind` already contains 'openapi' (2026-10-16-193500-tool-sources.sql),
-- so this file is purely additive:
--   * spec_url — the OpenAPI document URL for an openapi source. `endpoint_url`
--     keeps its W01 meaning (the origin credentials are pinned to); for an
--     openapi source that is the API BASE url, never the document host.
--   * last_discovery_summary — diagnostics of the last completed discovery
--     (skipped operations + reasons, non-fatal warnings). Export policy:
--     excludedOpen (jsonb).
--
-- No DML: every existing row is kind='mcp' with spec_url NULL, so the CHECK
-- validates immediately and no `set_config('breeze.scope','system')` is needed.
-- No RLS change: the table's shape and policies are unchanged.

ALTER TABLE tool_sources ADD COLUMN IF NOT EXISTS spec_url text;
ALTER TABLE tool_sources ADD COLUMN IF NOT EXISTS last_discovery_summary jsonb;

DO $$
BEGIN
  ALTER TABLE tool_sources DROP CONSTRAINT IF EXISTS tool_sources_spec_url_kind_chk;
  ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_spec_url_kind_chk
    CHECK (
      (kind <> 'openapi' OR spec_url IS NOT NULL)
      AND (kind <> 'mcp' OR spec_url IS NULL)
    );
END $$;

COMMENT ON COLUMN tool_sources.spec_url IS
  'OpenAPI document URL (openapi kind only). Operations route to endpoint_url, never to the document''s servers[].';
COMMENT ON COLUMN tool_sources.last_discovery_summary IS
  'Diagnostics of the last completed discovery (skipped operations, warnings). Left untouched by a failed discovery.';
