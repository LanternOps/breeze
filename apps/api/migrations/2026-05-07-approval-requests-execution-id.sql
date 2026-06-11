-- 2026-05-07-approval-requests-execution-id.sql
-- Bridge AI agent's aiToolExecutions approval flow to the mobile-readable
-- approval_requests flow by linking each approval row back to the
-- ai_tool_executions row that triggered it. Nullable because non-AI sources
-- (helper, MCP step-up, dev seed) still create approval_requests without an
-- execution row.
--
-- Idempotent: safe to re-apply on an already-migrated database.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS execution_id uuid;

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_execution_id_fkey;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_execution_id_fkey
  FOREIGN KEY (execution_id)
  REFERENCES ai_tool_executions(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS approval_requests_execution_id_idx
  ON approval_requests (execution_id);
