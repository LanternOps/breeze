-- Fleet Designer W01 (spec §4.4): the report type the design lane persists.
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-09-24-a-report-type-ai-org-narrative.sql). Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_fleet_design';
