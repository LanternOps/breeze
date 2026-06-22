-- PAM mobile approval bridge (#1254): link a fanned-out mobile approval_request
-- back to the elevation_request it was created for. When a uac_intercept
-- elevation lands 'pending', the agent-ingest route fans out one
-- approval_requests row per eligible technician approver (each carrying this
-- elevation_request_id); whichever approver decides first on mobile mirrors the
-- decision back to the elevation (first-wins CAS) and the sibling approval rows
-- are expired.
--
-- No RLS change: approval_requests stays Shape 6 (user_id-scoped). The new
-- column is just a back-reference; the row is still owned by its user_id and
-- the existing user-scoped policy continues to govern visibility.
-- ON DELETE SET NULL so a purged elevation leaves the approval row readable for
-- audit (mirrors the execution_id link's posture).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS; the FK is
-- added only when absent via a pg_constraint existence check.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS elevation_request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'approval_requests_elevation_request_id_fkey'
  ) THEN
    ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_elevation_request_id_fkey
      FOREIGN KEY (elevation_request_id)
      REFERENCES elevation_requests(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS approval_requests_elevation_request_id_idx
  ON approval_requests(elevation_request_id);
