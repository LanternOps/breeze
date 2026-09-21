-- Hardware Lifecycle report: the report type. Enum add ONLY, in its own file:
-- a label added by ALTER TYPE cannot be used until the transaction that added
-- it commits (precedent: 2026-10-16-170400-report-type-ai-fleet-design.sql).
-- Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'hardware_lifecycle';
