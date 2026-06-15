-- AI for Office — workbook-write approval policy (governance follow-up).
--
-- Adds client_ai_org_policies.write_approval: the org-level gate that decides
-- whether the end user is even ALLOWED to flip the pane into auto-apply.
--   'ask'        — every workbook write is approved by the end user (default).
--   'allow_auto' — the org permits the pane's Auto toggle (still audited).
--
-- Default-deny: the column defaults to 'ask' and the API normalises any
-- non-'allow_auto' value back to 'ask' (services/clientAiPolicy.ts), so an
-- absent/legacy row can never auto-apply. RLS already exists on this table
-- (2026-06-12-b-client-ai-foundation.sql) — NOT re-added here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded CHECK add.

ALTER TABLE client_ai_org_policies
  ADD COLUMN IF NOT EXISTS write_approval TEXT NOT NULL DEFAULT 'ask';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_ai_org_policies_write_approval_check'
  ) THEN
    ALTER TABLE client_ai_org_policies
      ADD CONSTRAINT client_ai_org_policies_write_approval_check
      CHECK (write_approval IN ('ask', 'allow_auto'));
  END IF;
END $$;
