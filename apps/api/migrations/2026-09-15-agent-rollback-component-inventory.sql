-- Persist the agent-declared complete installed rollback component set. NULL
-- means the endpoint could not prove a complete inventory and rollback must
-- fail closed. The 2026-09-15 sequence follows the already-shipped 09-14
-- rollback migration; it is intentionally not backdated to wall-clock time.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS rollback_component_versions jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devices_rollback_component_versions_object_check'
  ) THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_rollback_component_versions_object_check
      CHECK (
        rollback_component_versions IS NULL
        OR jsonb_typeof(rollback_component_versions) = 'object'
      );
  END IF;
END $$;
