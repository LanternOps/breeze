-- Bind an AI session to one customer M365 connection for its lifetime, and
-- correlate a tool execution to its Delegant audit entry.
ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS delegant_m365_connection_id UUID
  REFERENCES delegant_m365_connections (id);

ALTER TABLE ai_tool_executions
  ADD COLUMN IF NOT EXISTS delegant_tool_call_id VARCHAR(64);
