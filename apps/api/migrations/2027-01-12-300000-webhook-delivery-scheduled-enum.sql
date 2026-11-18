-- #10530: 'scheduled' — a persisted webhook retry waiting for its next attempt.
--
-- This file only adds the enum value; it never uses it. autoMigrate wraps
-- each file in its own transaction, and Postgres forbids using an enum value
-- in the transaction that added it, so the index that names 'scheduled' lives
-- in 2027-01-12-300100-webhook-delivery-scheduled-indexes.sql, which sorts after
-- this one. No rows are written, so no breeze.scope election is needed.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'webhook_delivery_status') THEN
    ALTER TYPE webhook_delivery_status ADD VALUE IF NOT EXISTS 'scheduled';
  END IF;
END $$;
