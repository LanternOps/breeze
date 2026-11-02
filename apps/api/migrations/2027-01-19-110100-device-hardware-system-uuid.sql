-- #8318 wave 2-1 — hardware hints, part 2 of 4: `device_hardware` only
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §7.2).
--
--   device_hardware.system_uuid uuid
--     The SMBIOS system UUID the agent reports at enroll and in the hardware
--     report (Windows Win32_ComputerSystemProduct.UUID, Linux product_uuid,
--     macOS IOPlatformUUID), normalized to the canonical form by both the
--     agent and the API; placeholders and malformed values are stored NULL.
--     A reinstall hint only: it never authorizes anything (#2764).
--
-- Tenancy: device_hardware is an org-cascade device child; the column is
-- classified `included` in CORE_TENANT_EXPORT_POLICY. It is material for the
-- partner export (breeze_partner_export_device_child_update compares every
-- column outside its excluded map), which is right: the column is exported.
--
-- The two lookup indexes are built CONCURRENTLY by the @no-transaction
-- 2027-01-19-110200, so the hardware-report writer is never blocked by a build.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only (nullable, no default: catalog
-- only, no rewrite). No row is written, so no system-scope election is
-- needed.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.device_hardware ADD COLUMN IF NOT EXISTS system_uuid uuid;
