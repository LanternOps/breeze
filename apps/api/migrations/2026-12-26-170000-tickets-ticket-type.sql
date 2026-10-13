-- #7900 (feature #8592 W01): tickets.ticket_type, the fixed ITIL core set
-- (incident | service_request | problem | change). A separate axis from
-- work_kind (delivery mode); display labels come from i18n only.
--
-- Lock behaviour: ADD COLUMN with a constant DEFAULT is metadata-only on
-- PG >= 11 (no table rewrite, no row writes); existing tickets read as
-- 'incident' immediately. The (org_id, ticket_type, status) index is built
-- CONCURRENTLY in its own @no-transaction migration
-- (2026-12-26-170100-tickets-ticket-type-index.sql) so this ACCESS EXCLUSIVE
-- lock is held only for the catalog update, never across a scan of tickets.
--
-- Idempotent. Writes no rows, so no breeze.scope election.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_type') THEN
    CREATE TYPE ticket_type AS ENUM ('incident', 'service_request', 'problem', 'change');
  END IF;
END $$;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type ticket_type NOT NULL DEFAULT 'incident';
