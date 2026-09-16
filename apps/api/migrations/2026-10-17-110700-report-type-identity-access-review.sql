-- Identity & Access Review report: the report type (#5784 W06). Enum add ONLY,
-- in its own file: a label added by ALTER TYPE cannot be used until the
-- transaction that added it commits, and autoMigrate wraps each file in one
-- transaction (precedent: 2026-10-16-180700-report-type-hardware-lifecycle.sql).
-- No rows are written, so no breeze.scope election is required. Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'identity_access_review';
