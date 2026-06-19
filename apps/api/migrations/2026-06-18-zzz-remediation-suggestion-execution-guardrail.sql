-- Guard remediation suggestion terminal statuses so execution metrics cannot
-- be spoofed without a linked execution rail. autoMigrate wraps this file in a
-- transaction.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'remediation_suggestions_terminal_execution_link_check'
      AND conrelid = 'public.remediation_suggestions'::regclass
  ) THEN
    ALTER TABLE public.remediation_suggestions
      ADD CONSTRAINT remediation_suggestions_terminal_execution_link_check
      CHECK (
        status NOT IN ('executed', 'failed')
        OR tool_execution_id IS NOT NULL
        OR script_execution_id IS NOT NULL
        OR playbook_execution_id IS NOT NULL
      ) NOT VALID;
  END IF;
END $$;
