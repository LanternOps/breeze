-- Org lifecycle spec (2026-08-26): merge fence + archive states.
-- Own file: ALTER TYPE ... ADD VALUE cannot run in the same transaction as
-- first use of the value, and each migration file is one transaction.
-- 'merging'  — transient fence while an org-merge job re-tenants rows.
-- 'archived' — hidden + read-only, retention timer running.
-- 'purging'  — CAS'd from 'archived' at purge time; restore is refused.
ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'merging';
ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'archived';
ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'purging';
