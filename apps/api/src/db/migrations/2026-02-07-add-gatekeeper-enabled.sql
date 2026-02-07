-- Add macOS Gatekeeper/Guardian posture field to endpoint security status.
ALTER TABLE security_status
ADD COLUMN IF NOT EXISTS gatekeeper_enabled boolean;
