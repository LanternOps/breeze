-- #10411: 'refused' — the platform refused an AI tool call before it ran.
--
-- The chat pre-tool hook now writes one ai_tool_executions row for every call
-- it refuses: a guardrail block, RBAC, the rate limit, input validation, the
-- session allowlist or Wisp ceiling, or a Tier 3 call whose action intent
-- could not be created. Those rows are 'refused', not 'rejected', so
-- 'rejected' keeps meaning what it meant before: the approval lifecycle ended
-- without an approval (a human denied it, it expired, or the wait ended). The
-- analytics that count 'rejected' (routes/ai.ts, aiToolUsageReport.ts) are
-- therefore unchanged by the new rows.
--
-- This file only adds the enum value; it never uses it. autoMigrate wraps each
-- file in its own transaction, and Postgres forbids using an enum value in the
-- transaction that added it. Same guard as
-- 2027-01-10-100000-pam-elevation-withdrawn-enum.sql.
-- No rows are written, so no breeze.scope election is needed.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_tool_status') THEN
    ALTER TYPE ai_tool_status ADD VALUE IF NOT EXISTS 'refused';
  END IF;
END $$;
