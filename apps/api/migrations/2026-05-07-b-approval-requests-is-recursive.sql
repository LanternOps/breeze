-- 2026-05-07-b-approval-requests-is-recursive.sql
-- Server-issued boolean replacing the mobile client's brittle label-prefix
-- heuristic for detecting "recursive" approvals (the same phone is the
-- requester). When true, the mobile UI requires a 5-second hold-to-confirm
-- after biometric as an explicit deliberate moment for self-approval.
--
-- Defaults to FALSE because today no insert site populates it as TRUE.
-- The recursive case fires once an OAuth-driven mobile MCP path lands and
-- the same phone owner is the request target.
--
-- Idempotent: safe to re-apply on an already-migrated database.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS is_recursive boolean NOT NULL DEFAULT false;
