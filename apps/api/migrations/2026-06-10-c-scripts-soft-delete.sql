-- Soft delete for scripts (issue #1208).
--
-- Hard `DELETE FROM scripts` violates the FK constraints from script_executions
-- / script_execution_batches (ON DELETE NO ACTION) as soon as a script has been
-- run, so the delete throws a 500 and the script can never be removed. We switch
-- to soft delete: the DELETE handler stamps deleted_at and all read paths filter
-- `deleted_at IS NULL`, preserving execution history while hiding the script.

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS deleted_at timestamp;

-- Partial index keeps the common "active scripts" listing fast.
CREATE INDEX IF NOT EXISTS scripts_active_idx ON scripts (org_id) WHERE deleted_at IS NULL;
