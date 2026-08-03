-- Enrollment idempotency (#2764): uninstall intent, replacement suggestion,
-- and bootstrap-slot refund linkage. Spec:
-- docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md
ALTER TABLE devices ADD COLUMN IF NOT EXISTS uninstall_intent_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS possible_replacement_of_device_id uuid;
DO $$ BEGIN
  ALTER TABLE devices
    ADD CONSTRAINT devices_possible_replacement_fk
    FOREIGN KEY (possible_replacement_of_device_id) REFERENCES devices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE enrollment_keys ADD COLUMN IF NOT EXISTS bootstrap_token_id uuid;
DO $$ BEGIN
  ALTER TABLE enrollment_keys
    ADD CONSTRAINT enrollment_keys_bootstrap_token_fk
    FOREIGN KEY (bootstrap_token_id) REFERENCES installer_bootstrap_tokens(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reaper scan path (Task 5): intent-stamped, not-yet-decommissioned rows.
CREATE INDEX IF NOT EXISTS idx_devices_uninstall_intent
  ON devices (uninstall_intent_at) WHERE uninstall_intent_at IS NOT NULL;
