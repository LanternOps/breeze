-- AI chargeback W10 (#7608, feature #7598): the `ai_usage_by_client` business
-- report type — per-client AI usage (requests, tokens, Breeze cost, chargeable
-- amount per currency, billed vs unbilled) over the authoritative
-- ai_invocations ledger. Generator: services/businessReports/aiUsageByClientReport.ts.
--
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-11-08-170300-backup-status-report-type.sql, 2026-10-27-130000-report-type-business.sql).
-- No DML, so no breeze.scope election. Idempotent via IF NOT EXISTS.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_usage_by_client';
