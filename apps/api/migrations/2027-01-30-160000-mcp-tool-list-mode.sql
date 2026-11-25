-- #12429 (external MCP progressive disclosure, W02): which tool list a
-- credential's MCP client is shown. NULL = follow the deployment default
-- (MCP_TOOL_LIST_DEFAULT, `full` as shipped); 'full' / 'progressive' pin it.
--
-- Every credential that exists when this first runs is pinned to 'full', so a
-- later change of the deployment default cannot move an existing integration.
-- Credentials created afterwards start NULL.
--
-- Run-once: each table's own CHECK constraint is the marker. The backfill and
-- the constraint are written together, so a replay finds the constraint, adds
-- nothing and touches no row (a NULL row created since then stays NULL).
--
-- Every table reference is schema-qualified; the integration suite relies on it
-- to run this file against copies (mcpToolListModeMigration.integration.test.ts).
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS mcp_tool_list_mode text;
ALTER TABLE public.oauth_grants ADD COLUMN IF NOT EXISTS mcp_tool_list_mode text;

DO $$
DECLARE
  n bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'api_keys_mcp_tool_list_mode_check'
       AND conrelid = 'public.api_keys'::regclass
  ) THEN
    UPDATE public.api_keys SET mcp_tool_list_mode = 'full' WHERE mcp_tool_list_mode IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'mcp_tool_list_mode: % existing api_keys row(s) set to full', n;
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_mcp_tool_list_mode_check
      CHECK (mcp_tool_list_mode IS NULL OR mcp_tool_list_mode IN ('full', 'progressive'));
  END IF;
END $$;

DO $$
DECLARE
  n bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'oauth_grants_mcp_tool_list_mode_check'
       AND conrelid = 'public.oauth_grants'::regclass
  ) THEN
    -- oauth_grants' only policy is TO breeze_app, so on a database whose owner is
    -- neither a superuser nor a member of breeze_app no policy admits the owner
    -- whatever the scope says: the UPDATE would match zero rows, silently, and
    -- the CHECK below would still record the backfill as done. Lift FORCE for
    -- this one statement. The table is locked ACCESS EXCLUSIVE by the ALTER above
    -- until commit, so no other session can run without it, and an error rolls
    -- it back. (api_keys' policies are TO PUBLIC; system scope is enough there.)
    ALTER TABLE public.oauth_grants NO FORCE ROW LEVEL SECURITY;
    UPDATE public.oauth_grants SET mcp_tool_list_mode = 'full' WHERE mcp_tool_list_mode IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'mcp_tool_list_mode: % existing oauth_grants row(s) set to full', n;
    ALTER TABLE public.oauth_grants FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.oauth_grants
      ADD CONSTRAINT oauth_grants_mcp_tool_list_mode_check
      CHECK (mcp_tool_list_mode IS NULL OR mcp_tool_list_mode IN ('full', 'progressive'));
  END IF;
END $$;
