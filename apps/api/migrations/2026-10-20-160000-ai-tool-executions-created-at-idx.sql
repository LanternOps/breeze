-- @no-transaction
-- ai_tool_executions: created_at index for the AI tool-usage report (A-W01, #6148).
-- The table has only session_id and status indexes; the platform-admin report
-- (GET /api/v1/admin/ai/tool-usage) and the operator SQL in
-- docs/superpowers/specs/ai-mcp/sql/ window on created_at and would seq-scan.
-- CONCURRENTLY so a hot table is never locked; hence @no-transaction.
-- DDL only — no rows written, so no breeze.scope election is needed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_tool_executions_created_at_idx
  ON ai_tool_executions (created_at);
