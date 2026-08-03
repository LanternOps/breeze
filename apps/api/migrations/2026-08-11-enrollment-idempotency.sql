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

-- No FK here on purpose: installer_bootstrap_tokens.parent_enrollment_key_id
-- already references enrollment_keys(id) (2026-04-19-a migration), so a
-- reverse FK from enrollment_keys.bootstrap_token_id back to
-- installer_bootstrap_tokens would create a two-table cycle that
-- topologicalCascadeOrder() (tenantCascade.ts) cannot order, breaking org
-- cascade-delete for every org. Integrity is app-side; a dangling id after
-- the token row is deleted is harmless — the cancel/refund flow's decrement
-- UPDATE simply matches 0 rows.
ALTER TABLE enrollment_keys ADD COLUMN IF NOT EXISTS bootstrap_token_id uuid;

-- Reaper scan path (Task 5): intent-stamped, not-yet-decommissioned rows.
CREATE INDEX IF NOT EXISTS idx_devices_uninstall_intent
  ON devices (uninstall_intent_at) WHERE uninstall_intent_at IS NOT NULL;
