-- Validates the approval_method CHECK that the previous migration added NOT
-- VALID. A separate file so the scan runs in its own transaction, under a
-- SHARE UPDATE EXCLUSIVE lock that lets writes to script_executions continue.
-- Idempotent: validating an already valid constraint is a no-op. No row
-- writes, so no breeze.scope election.
ALTER TABLE script_executions
  VALIDATE CONSTRAINT script_executions_approval_method_chk;
