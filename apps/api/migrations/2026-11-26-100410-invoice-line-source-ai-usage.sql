-- AI chargeback W10 (#7608): invoice lines whose source is an ai_usage_charges
-- row. Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be
-- used until the transaction that added it commits (precedent:
-- 2026-11-08-170300-backup-status-report-type.sql). Appended LAST — the shared
-- INVOICE_LINE_SOURCE_TYPES tuple mirrors this order (invoices.enums.test.ts).
-- No DML, so no breeze.scope election. Idempotent via IF NOT EXISTS.
ALTER TYPE invoice_line_source_type ADD VALUE IF NOT EXISTS 'ai_usage';
