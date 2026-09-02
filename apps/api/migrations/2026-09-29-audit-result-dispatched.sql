-- #4225: agent.command.* audit rows are written at dispatch time
-- (services/commandQueue.ts) and previously hardcoded result='success', so a
-- command that later fails still reads as a successful completion in the
-- audit trail. Add a neutral 'dispatched' outcome to the audit_result enum
-- so the dispatch-time row can stop asserting an outcome it doesn't know yet.
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value
-- added by ALTER TYPE ... ADD VALUE inside the same transaction, and
-- autoMigrate wraps each file in one — so any statement referencing
-- 'dispatched' must live in a later file, not here (mirrors
-- 2026-09-05-b-audit-actor-type-ai-agent.sql).

ALTER TYPE public.audit_result ADD VALUE IF NOT EXISTS 'dispatched';
