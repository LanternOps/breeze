-- Software deployment visibility (PR 1, §1.1): dispatch claim marker.
-- dispatched_at is set when a deployment's per-device dispatch actually runs.
-- The scheduler claims rows via
--   UPDATE ... SET dispatched_at = now() WHERE id = $1 AND dispatched_at IS NULL RETURNING id
-- so it can never double-dispatch across API instances.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

ALTER TABLE software_deployments ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

-- Backfill shipped rows: immediate deployments were dispatched (fire-and-forget)
-- at creation time, so created_at is the honest approximation.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE software_deployments
  SET dispatched_at = created_at
  WHERE schedule_type = 'immediate'
    AND dispatched_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled dispatched_at = created_at on % immediate software_deployments rows', n;
  END IF;
END $$;
