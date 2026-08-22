-- Quote revisions (spec 2026-08-17): terminal status for a quote replaced by a
-- newer revision. Own file: ALTER TYPE ... ADD VALUE cannot run in the same
-- transaction as first use of the value (autoMigrate wraps each file in one).
ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'superseded';
