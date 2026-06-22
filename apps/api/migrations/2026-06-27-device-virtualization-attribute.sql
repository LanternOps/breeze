-- Issue #1387: orthogonal virtual/VDI device attribute for policy targeting.
--
-- Adds two columns to `devices`:
--   is_virtual               — true when the host runs on a hypervisor
--   virtualization_platform  — normalized hypervisor token (vmware / hyperv /
--                              virtualbox / qemu / kvm / xen / bochs /
--                              parallels), NULL when physical or undetermined.
--
-- These are a SECOND policy-targeting axis, NOT new device_role values: a
-- virtual workstation is still a workstation and keeps matching role-based
-- policies. The agent derives both from the SMBIOS hardware identity strings
-- (Manufacturer / Model / BIOS) it already collects.
--
-- RLS: `devices` already has org_id RLS policies; added columns inherit the
-- table's existing protection — no new policy required.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-application is a no-op.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_virtual boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS virtualization_platform varchar(30);
