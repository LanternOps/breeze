-- Record the run context each script execution ACTUALLY used (#4888).
--
-- `runAs` is resolved at dispatch time as `input.runAs ?? script.runAs`
-- (services/scriptDispatch.ts) and, until now, existed only inside the
-- transient `device_commands.payload` JSON. That payload is sanitised out of
-- every history/audit read (services/commandAudit.ts) and command rows are
-- reaped independently, so execution history could never answer "did this run
-- as SYSTEM or as the logged-in user?" — the question that made the OliveTech
-- GCPW failures look random (#4882).
--
-- Deliberately NULLABLE with NO default: rows written before this column
-- existed genuinely do not know their run context, and stamping them 'system'
-- would assert something we cannot prove. Readers render NULL as "unknown"
-- rather than as a value.
ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS run_as script_run_as;

-- The Windows session a `run_as = 'user'` run was pinned to (RDS session
-- targeting). NULL means "any interactive session", which is also what every
-- pre-existing row means.
ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS target_session_id integer;

COMMENT ON COLUMN script_executions.run_as IS
  'Run context resolved at dispatch (override ?? script default). NULL = recorded before #4888.';
COMMENT ON COLUMN script_executions.target_session_id IS
  'Windows session id a run_as=user execution was pinned to; NULL = any interactive session.';
