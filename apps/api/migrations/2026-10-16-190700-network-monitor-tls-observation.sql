-- Certificate observation for the expiring_certs sweep kind (#5751 W03, #5754).
--
-- Promotes the value the Go agent already collects on every HTTPS http_check
-- out of the untyped network_monitor_results.details blob (which nothing in
-- the repo reads) into typed columns, written beside the existing
-- lastStatus/lastResponseMs writeback in recordMonitorCheckResult.
--
-- NO DML and no DEFAULT on tls_state: historical rows have no observed host
-- and no state, and synthesising 'observed' for them would fabricate findings.
-- NULL means "never observed under the current agent", which is honest.
--
-- Adds plain columns only — no ownership, nullability or policy change — so it
-- is correct against network_monitors in either its pre- or post-#5291-W04
-- (org_id XOR partner_id) shape.

-- 1. Typed TLS observation columns on network_monitors.

ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_not_after     timestamptz;
-- THE endpoint the certificate actually belongs to. Redirects are followed by
-- default, so a monitor on a.example can legitimately report b.example's
-- certificate; a finding that omits this lies about which endpoint expires.
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_observed_host varchar(255);
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_issuer        varchar(255);
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_observed_at   timestamptz;
-- A TLS failure returns BEFORE certificate extraction, so a null tls_not_after
-- must never read as "fine". Three states, emitted by the agent, never derived.
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_state         varchar(16);

ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_tls_state_chk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_tls_state_chk
  CHECK (tls_state IS NULL OR tls_state IN ('observed', 'handshake_failed', 'not_tls'));

-- An observation is only meaningful with a time and a host attached.
ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_tls_observed_shape_chk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_tls_observed_shape_chk
  CHECK (tls_state IS DISTINCT FROM 'observed'
         OR (tls_not_after IS NOT NULL AND tls_observed_at IS NOT NULL AND tls_observed_host IS NOT NULL));

-- Serves loadExpiringCerts' ORDER BY tls_not_after ASC under its own predicate.
CREATE INDEX IF NOT EXISTS network_monitors_tls_expiry_idx
  ON network_monitors (org_id, tls_not_after)
  WHERE tls_state = 'observed' AND is_active = true;
