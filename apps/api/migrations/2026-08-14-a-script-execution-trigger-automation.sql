-- #3162: automation `run_script` actions now mint a real `script_executions`
-- row so the agent's stdout can be persisted against it. Those rows need a
-- trigger_type that says where they came from.
--
-- ALTER TYPE ... ADD VALUE is the ONLY statement in this file: under
-- autoMigrate's per-file transaction the new label is uncommitted until the
-- file commits, so no later statement here may use it. IF NOT EXISTS makes
-- re-application a no-op.
ALTER TYPE trigger_type ADD VALUE IF NOT EXISTS 'automation';
