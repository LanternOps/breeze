-- 2026-06-13-d-ai-for-office-host-keying.sql
-- AI for Office multi-host: a client session's host is encoded in
-- ai_sessions.type as `${host}_client`. Generalize the excel-only principal
-- CHECK so EVERY client session type requires a client principal. Idempotent;
-- fix-forward replacement of ai_sessions_excel_client_principal_check.
-- conrelid-scoped lookups mirror the foundation migration (2026-06-12-b) — a
-- constraint name is unique per-table, not globally.
DO $$
BEGIN
  -- Drop the old excel-only constraint if it is still present.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_excel_client_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions DROP CONSTRAINT ai_sessions_excel_client_principal_check;
  END IF;
  -- Add the generalized constraint once.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_client_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_client_principal_check
      CHECK (
        type NOT IN ('excel_client', 'word_client', 'powerpoint_client', 'outlook_client')
        OR client_user_id IS NOT NULL
      );
  END IF;
END $$;
