-- B-W02 (#6156): per-grant MCP tool domains. NULL = unrestricted (every
-- domain, including domains added later and unclassified tools). A restricted
-- principal stores a non-empty set of grantable domains; 'core' is implicit
-- and never stored. Vocabulary is validated in the app (AI_TOOL_DOMAINS);
-- unknown stored values grant nothing at read time.
--
-- The CHECK covers shape only. `array_position(..., NULL) IS NULL` rejects a
-- NULL element: with one present, `'core' = ANY(...)` is UNKNOWN and a CHECK
-- would accept the row. No rows are written, so no system scope is needed.
ALTER TABLE api_keys     ADD COLUMN IF NOT EXISTS mcp_domains text[];
ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS mcp_domains text[];

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_mcp_domains_shape_check') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_mcp_domains_shape_check CHECK (
      mcp_domains IS NULL OR (cardinality(mcp_domains) > 0 AND NOT ('core' = ANY (mcp_domains)) AND array_position(mcp_domains, NULL) IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_grants_mcp_domains_shape_check') THEN
    ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_mcp_domains_shape_check CHECK (
      mcp_domains IS NULL OR (cardinality(mcp_domains) > 0 AND NOT ('core' = ANY (mcp_domains)) AND array_position(mcp_domains, NULL) IS NULL)
    );
  END IF;
END $$;
