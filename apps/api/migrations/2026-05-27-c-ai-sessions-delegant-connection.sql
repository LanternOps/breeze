-- Bind an AI session to one customer M365 connection for its lifetime, and
-- correlate a tool execution to its Delegant audit entry.
ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS delegant_m365_connection_id UUID
  REFERENCES delegant_m365_connections (id) ON DELETE SET NULL;

-- For DBs that added the column before ON DELETE SET NULL was specified, swap
-- the default NO ACTION FK so deleting a connection nulls the binding instead
-- of blocking. Idempotent: only acts when the current rule isn't already SET
-- NULL ('n'); re-runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_delegant_m365_connection_id_fkey'
      AND conrelid = 'ai_sessions'::regclass
      AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE ai_sessions
      DROP CONSTRAINT ai_sessions_delegant_m365_connection_id_fkey;
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_delegant_m365_connection_id_fkey
      FOREIGN KEY (delegant_m365_connection_id)
      REFERENCES delegant_m365_connections (id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE ai_tool_executions
  ADD COLUMN IF NOT EXISTS delegant_tool_call_id VARCHAR(64);
