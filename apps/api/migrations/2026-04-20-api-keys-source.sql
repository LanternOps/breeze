-- Track the provenance of an API key row so the web UI can surface a label
-- (e.g. "MCP Provisioning") and so audit queries can distinguish manually-
-- created keys from those minted by the MCP agent-bootstrap flow.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'mcp_provisioning'));
