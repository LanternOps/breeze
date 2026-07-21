-- OS-level pending-reboot flag reported by the agent in every main-agent
-- heartbeat (Windows registry checks; Linux reboot-required markers /
-- needs-restarting). Self-clears on the first post-reboot heartbeat.
-- Backs the system.rebootRequired device filter and the "Reboot pending"
-- UI badge. Spec: docs/superpowers/specs/vuln-patch/2026-06-11-pending-reboot-indicator-design.md
ALTER TABLE devices ADD COLUMN IF NOT EXISTS pending_reboot boolean NOT NULL DEFAULT false;

-- Partial index: the fleet-wide system.rebootRequired filter only ever looks
-- for pending_reboot = true, which is a small minority of rows.
CREATE INDEX IF NOT EXISTS devices_pending_reboot_idx ON devices (pending_reboot) WHERE pending_reboot = true;
