-- Partner-level Service Management mode (#5075 W04).
-- Spec: docs/superpowers/specs/web-ui/2026-09-06-organization-record-page-design.md (Part 2)
--
-- Three modes:
--   'native'   — Breeze runs the service desk & billing (default, today's behaviour)
--   'external' — the partner's PSA is the system of record; a partner-wide
--                psa_connections row must be bound
--   'off'      — RMM only: the service desk and billing surfaces are hidden and
--                ticketService.createTicket refuses with 409
--
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps each file in its own
-- transaction). No DML, so no breeze.scope elevation is needed.
-- `partners` has no org_id, so no tenantCascade / export-policy registration applies.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS service_management_mode text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS service_management_psa_connection_id uuid
    REFERENCES psa_connections(id) ON DELETE RESTRICT;

-- RESTRICT (not SET NULL / CASCADE): dropping the bound connection out from
-- under an 'external' partner would violate the pairing CHECK below, so the
-- delete must fail loudly rather than silently leave the partner in a shape the
-- constraint forbids.

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_service_management_mode_chk;
ALTER TABLE partners ADD CONSTRAINT partners_service_management_mode_chk
  CHECK (service_management_mode IN ('native', 'external', 'off'));

-- Biconditional, not a one-way implication: 'external' REQUIRES a connection and
-- 'native'/'off' FORBID one, so a stale connection id can't survive a mode
-- change back to native and quietly re-bind if the partner flips to external again.
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_service_management_connection_chk;
ALTER TABLE partners ADD CONSTRAINT partners_service_management_connection_chk
  CHECK ((service_management_mode = 'external') = (service_management_psa_connection_id IS NOT NULL));
