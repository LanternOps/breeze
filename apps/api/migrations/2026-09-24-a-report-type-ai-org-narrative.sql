-- Phase 2 wave P2-3 (#4187 / #4190): AI weekly org narrative report type.
-- ALTER TYPE ... ADD VALUE is the ONLY statement in this file (see
-- 2026-06-29-a-report-type-security-compliance.sql for why: under autoMigrate's
-- per-file transaction the new label is uncommitted until the file commits, so
-- no later statement here may use it). IF NOT EXISTS makes re-application a
-- no-op.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_org_narrative';
