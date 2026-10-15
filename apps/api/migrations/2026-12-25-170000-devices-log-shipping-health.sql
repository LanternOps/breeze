-- #8608 / #8607 (log-shipping health W01; originating issue #8406): the agent's
-- heartbeat reports whether its own log shipping is failing. The API classifies
-- each beat and persists only on state change, so these three scalars describe
-- the device row 1:1 (same pattern as helper_install_issue, #6925).
-- Nullable ADDs only (no table rewrite); no row writes, so no scope election.
-- NULL state = unknown (old agent or field absent), never healthy and never failing.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS log_shipping_state varchar(16);

-- NOT VALID: no table scan under ACCESS EXCLUSIVE (every existing row is NULL
-- anyway); keeps the ALTER metadata-only, as the #6925 precedent did.
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_log_shipping_state_chk
    CHECK (log_shipping_state IN ('ok', 'quiet', 'failing')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS log_shipping_failure_started_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS log_shipping_last_error varchar(200);

-- Partial index: empty at creation (all NULL), so the build is a single scan.
CREATE INDEX IF NOT EXISTS devices_log_shipping_failing_idx
  ON devices (log_shipping_failure_started_at)
  WHERE log_shipping_failure_started_at IS NOT NULL;
