-- Phase 2: record a free-text reason when a sent quote is declined.
-- Idempotent: ADD COLUMN IF NOT EXISTS. No new table, no RLS change
-- (quotes already has org-axis RLS from 2026-06-16-quotes.sql).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason text;
