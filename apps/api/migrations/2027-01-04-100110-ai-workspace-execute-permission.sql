-- ai_workspace:execute (Wisp W02 #9908, Wisp design §4.6). The sandbox
-- workspace tools (workspace_stage/run/collect/cancel) execute arbitrary code;
-- their TOOL_PERMISSIONS entries move from the low-bar ai_agents:read to this
-- execute-class key before any chat-initiated launch path returns.
--
-- Granted to NO role by name: Partner Admin matches it through `*:*` at
-- runtime (per-axis grant matching); everyone else needs an explicit role edit.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action), only a
-- primary key on id, so a conflict-target upsert would add a duplicate row on
-- every re-apply. Explicit existence check instead. Idempotent; no inner
-- transaction (autoMigrate wraps the file).
--
-- System scope first: the insert would otherwise abort with 42501 on a
-- connection that does not bypass RLS (#4518). is_local = true scopes it to
-- autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- The description is normative and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts.
DO $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'ai_workspace' AND action = 'execute'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('ai_workspace', 'execute', 'Stage, run and collect code in AI sandbox workspaces');
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  IF n > 0 THEN
    RAISE NOTICE 'seeded permission ai_workspace:execute';
  END IF;
END $$;
