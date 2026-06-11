-- 2026-05-07-b-account-deletion-admin-note.sql
-- Adds admin_note column to account_deletion_requests so reviewers can record
-- a free-text reason when rejecting (or, optionally, approving) a request.
-- Idempotent: safe to re-apply.

ALTER TABLE account_deletion_requests
  ADD COLUMN IF NOT EXISTS admin_note text;
