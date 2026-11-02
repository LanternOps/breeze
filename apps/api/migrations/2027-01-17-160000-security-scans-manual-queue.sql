-- #10057 gap 2: a caller-initiated "Scan now" goes through the security-scan
-- dispatch claim (jobs/securityScanClaim.ts), so the org / partner / device
-- concurrency caps apply to it like every other origin. What the old direct
-- dispatch carried in memory now lives on the row until the claim:
--   paths                 custom-scan targets (NULL unless scan_type = 'custom')
--   ai_origin             the AI caller, re-checked at dispatch and carried onto
--                         the command
--   caller_mfa_satisfied  NULL = no caller (scheduled / sweep): the policy's
--                         stored quarantine authority applies. true / false =
--                         a Scan now under the caller's authority, with or
--                         without a satisfied MFA session
--   queue_expires_at      an undispatched queued row past this is expired
--
-- Additive only: four nullable columns on an existing table (RLS already
-- enabled + forced, already in the org cascade), plus a partial index for the
-- pump's expiry / re-admission scans. No rows are written.

ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS paths text[];
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS ai_origin jsonb;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS caller_mfa_satisfied boolean;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS queue_expires_at timestamp;

CREATE INDEX IF NOT EXISTS security_scans_queue_expiry_idx
  ON security_scans (queue_expires_at)
  WHERE status = 'queued' AND queue_expires_at IS NOT NULL;
