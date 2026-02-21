-- Update Rings: Evolve patch_policies into Update Rings + ring-scoped approvals
-- All changes are additive. Existing data remains valid (ringId=NULL = org-wide/legacy).

BEGIN;

-- 1. Add ring columns to patch_policies
ALTER TABLE patch_policies
  ADD COLUMN IF NOT EXISTS ring_order       integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deferral_days    integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deadline_days    integer,
  ADD COLUMN IF NOT EXISTS grace_period_hours integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS categories       text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exclude_categories text[] NOT NULL DEFAULT '{}';

-- 2. Add ringId to patch_approvals for ring-scoped approvals
ALTER TABLE patch_approvals
  ADD COLUMN IF NOT EXISTS ring_id uuid REFERENCES patch_policies(id);

-- Drop old unique constraint (orgId, patchId) — allows per-ring approvals
DROP INDEX IF EXISTS patch_approvals_org_patch_unique;

-- New unique index: one approval per (org, patch, ring) with NULL ring = org-wide
CREATE UNIQUE INDEX IF NOT EXISTS patch_approvals_org_patch_ring_unique
  ON patch_approvals (org_id, patch_id, COALESCE(ring_id, '00000000-0000-0000-0000-000000000000'));

-- 3. Add ringId FK to patch_jobs
ALTER TABLE patch_jobs
  ADD COLUMN IF NOT EXISTS ring_id uuid REFERENCES patch_policies(id);

-- 4. Add ringId FK to patch_compliance_snapshots
ALTER TABLE patch_compliance_snapshots
  ADD COLUMN IF NOT EXISTS ring_id uuid REFERENCES patch_policies(id);

-- 5. Index for fast ring-scoped queries
CREATE INDEX IF NOT EXISTS idx_patch_approvals_ring_id ON patch_approvals(ring_id) WHERE ring_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patch_jobs_ring_id ON patch_jobs(ring_id) WHERE ring_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patch_compliance_snapshots_ring_id ON patch_compliance_snapshots(ring_id) WHERE ring_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patch_policies_ring_order ON patch_policies(org_id, ring_order);

COMMIT;
