-- 2026-06-10-a-elevation-flow-type-ai-tool-action.sql
--
-- Phase 1 of Helper privileged-action governance (security finding A):
-- Helper AI tool actions become PAM elevation requests. The enum value is
-- added in its own migration file because the -b- file's CHECK constraint
-- references it, and PG forbids using a new enum value in the transaction
-- that added it ("unsafe use of new value of enum type"). autoMigrate wraps
-- each file in one transaction, so the file split is the transaction split.
ALTER TYPE elevation_flow_type ADD VALUE IF NOT EXISTS 'ai_tool_action';
