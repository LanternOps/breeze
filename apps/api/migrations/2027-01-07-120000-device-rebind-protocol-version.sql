-- #8318 wave 1b-2 — the bounded rebind
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.1, §6.2).
--
-- One expansion-only column, no data migration:
--
--   devices.rebind_protocol_version
--     The agent's declared rebind capability. 1 = this agent build follows the
--     bounded rebind (§6.3–§6.6): it verifies the signed `rebind` directive on
--     the heartbeat, generates and persists its staged credential set before
--     phase 1, and confirms with the confirm-only token. 0 (the default, and
--     every pre-existing row) means "not capable": such a device can never be
--     the SOURCE of a reattach, and no heartbeat sends it a directive.
--     Written by enroll (fresh insert and the F3 re-enroll, which is a new
--     install), and NON-STICKY on every main and parked heartbeat, so a
--     downgrade reports back down to 0. Not reset at the install boundary
--     (services/deviceInstallBoundary): the new install reports it at enroll.
--
-- Tenancy: devices is an org-cascade table; the column is classified
-- `included` in CORE_TENANT_EXPORT_POLICY.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only. A constant default is
-- catalog-only (no table rewrite). No RLS change; no row is written, so no
-- system-scope election is needed. lock_timeout bounds how long the ALTER may
-- queue behind a long transaction on this hot table; on timeout autoMigrate
-- aborts boot and the file re-runs cleanly.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS rebind_protocol_version integer NOT NULL DEFAULT 0;
