-- Pre-assignment enrollment: the holding-org type.
--
-- Adds the org type of the hidden per-partner holding org where devices
-- enrolled with a partner deploy key stay parked until assigned.
--
-- Nothing in THIS file may use the new label: Postgres rejects using an enum
-- value in the transaction that added it (55P04 "unsafe use of new value") and
-- autoMigrate wraps each file in one transaction. The partial unique index and
-- the guard triggers live in 2026-11-08-170100 (same split as
-- 2026-08-13-a-quick-support-sessions.sql / 2026-08-13-b-quick-support-org-index.sql).
--
-- Idempotent. No inner BEGIN/COMMIT. Writes no rows.

ALTER TYPE org_type ADD VALUE IF NOT EXISTS 'unassigned_pool';
